import { join } from 'path'
import { LichManager, LichConnection } from './lib/lich-manager'
import { GameConnection } from './lib/game-connection'
import { CmdScriptEngine } from './lib/cmd-script-engine'
import { MapStore, type StoredZone } from './lib/map-store'
import { LogStore, logSlug, stripToLines } from './lib/log-store'
import { sgeAuth, type SGELaunchKey } from './lib/sge-auth'
import {
  getAvatar, publishAvatar, deleteAvatar, isAvatarServiceEnabled,
} from './lib/avatar-service'
import { ensurePortrait } from './lib/portrait-service'
import { encryptString, decryptString, isEncryptionAvailable } from './crypto'
import type { UserContext } from './user-context'
import type { PortAllocator } from './port-allocator'
import type { MessageHub } from './message-hub'
import { TriggerEngine, DEFAULT_PUSH, type NotifRule, type PushConfig } from './trigger-engine'
import { provisionLichHome, ensureUserScriptsDir, sharedLichRoot, writeLichEntry } from './lich-home'
import { listFiles, readFile, writeFile, deleteFile } from './lich-files'
import { notify } from './push'

/** Sends an event to the connected client (replaces mainWindow.webContents.send). */
export type Emit = (channel: string, ...args: unknown[]) => void

/** Server-global singletons injected into every session. */
export interface ServerContext {
  map: MapStore          // shared community world-map (see user-context.ts)
  ports: PortAllocator   // Lich frontend-port pool (multi-instance support)
  hub: MessageHub        // server-global messaging presence + router (message-hub.ts)
  dataDir: string
}

/**
 * One Session == one authenticated client == what a single Electron window did in
 * index.ts. The game connection, Lich process, script engine, and trigger engine
 * are per-session; settings / broadcast / logging come from the per-USER context
 * (UserContext), and the world map is a server-global singleton.
 *
 * The client drives this over WebSocket: `invoke(channel, args)` mirrors
 * ipcMain.handle, and `emit(channel, ...)` mirrors webContents.send.
 */
export class Session {
  private readonly gameConn = new GameConnection()
  private readonly lichConn = new LichConnection()
  private readonly lichMgr  = new LichManager()
  private readonly cmdEngine: CmdScriptEngine
  private readonly triggers: TriggerEngine
  private readonly lichLogBuffer: string[] = []
  // Per-session (not per-user): logging is a per-character setting and one user can
  // play several characters concurrently. Writes into this user's shared logs/ dir.
  private readonly log: LogStore

  private charName = ''
  private lichPort: number | null = null   // allocated only while Lich is running

  // Every attached client (WebSocket) that should receive this session's events.
  // Usually one, but several when devices WATCH the same session — events broadcast
  // to all, so a newcomer mirrors the stream instead of stealing it.
  private readonly clients = new Set<Emit>()
  // Recent raw game chunks, replayed to a freshly-attaching WATCH client so it sees
  // the current room/vitals/scrollback instead of a blank screen until next activity.
  private readonly recentOutput: string[] = []
  // The room name + description are only sent on room CHANGE, so in a long session
  // they scroll out of recentOutput — unlike objs/players/exits, which the game
  // re-sends often. Keep the latest chunk carrying each so a reattaching or watching
  // client can repopulate the room panel instead of showing exits/objs with no name.
  private stickyRoomName: string | null = null
  private stickyRoomDesc: string | null = null

  // Per-session SGE login continuation (each user logs in independently).
  private pendingSelectInstance:  ((code: string) => Promise<unknown>) | null = null
  private pendingSelectCharacter: ((id: string) => Promise<SGELaunchKey>) | null = null
  private lichReadyDetected = false
  // Held only between login() and selectCharacter() so headless Lich can write its
  // saved-login entry.yaml; cleared right after (never persisted in the session).
  private loginPassword: string | null = null

  constructor(
    private readonly user: UserContext,
    private readonly server: ServerContext,
  ) {
    const s = this.user.settings
    this.log = new LogStore(this.user.dir)
    this.cmdEngine = new CmdScriptEngine(
      () => s.get('scriptDir') || join(this.user.dir, 'scripts'),
    )
    // Server-side alert evaluation → Web Push (fires even when the PWA is closed).
    // Command-trigger auto-run stays OFF so the renderer stays authoritative and
    // commands don't double-fire; see trigger-engine.ts.
    this.triggers = new TriggerEngine(
      () => {
        const all = s.getAll() as unknown as { notifRules?: NotifRule[]; push?: PushConfig }
        return {
          notifRules: all.notifRules ?? [],
          triggers:   s.getCharSettings(this.charName).triggers,
          push:       all.push ?? DEFAULT_PUSH,
          charName:   this.charName,
        }
      },
      (cmd) => { this.gameConn.send(cmd); this.emit('game:sent', cmd) },
      { userId: this.user.userId, autoRunCommandTriggers: false },
    )
    this.wireEvents()
  }

  /** Point the log at `charName` and resolve that character's logging flag. */
  private applyLogging(charName: string): void {
    this.log.setChar(charName)
    this.log.setEnabled(this.user.settings.getCharSettings(charName).logging)
  }

  private lichLog(line: string): void {
    this.lichLogBuffer.push(line)
    if (this.lichLogBuffer.length > 200) this.lichLogBuffer.shift()
    this.emit('lich:log', line)
  }

  // ── Event wiring (mirrors setupIpcHandlers' *.on(...) blocks) ────────────────
  private wireEvents(): void {
    const { broadcast } = this.user
    const log = this.log
    const { map } = this.server

    this.lichMgr.on('log',    (l: string) => this.lichLog(l))
    this.lichMgr.on('status', (s: string) => this.emit('lich:status', s))
    this.lichMgr.on('error',  (m: string) => { this.lichLog('[error] ' + m); this.emit('lich:error', m) })
    this.lichMgr.on('ready',  (port: number) =>
      this.lichLog('[lich] Lich ready on port ' + port + ' -- ;commands route through main connection'))

    this.cmdEngine.on('send',   (cmd: string)   => { this.gameConn.send(cmd); this.emit('game:sent', cmd) })
    this.cmdEngine.on('echo',   (text: string)  => this.emit('script:output', text))
    this.cmdEngine.on('status', (info: unknown) => this.emit('script:status', info))
    this.cmdEngine.on('error',  (msg: string)   => { this.lichLog('[script] ' + msg); this.emit('script:output', msg) })

    broadcast.on('command', (cmd: string) => this.emit('broadcast:incoming', cmd))
    map.on('zoneChanged',   (zone: StoredZone) => this.emit('map:zone-changed', zone))

    this.gameConn.on('log',          (l: string) => this.lichLog('[game] ' + l))
    this.gameConn.on('connected',    () => { this.lichLog('[game] Connected'); this.emit('game:connected'); this.syncPresence() })
    this.gameConn.on('disconnected', () => { this.lichLog('[game] Disconnected'); this.emit('game:disconnected'); this.syncPresence() })
    this.gameConn.on('error',        (e: string) => { this.lichLog('[game] Error: ' + e); this.emit('game:error', e) })
    this.gameConn.on('data',         (r: string) => {
      this.recentOutput.push(r)
      if (this.recentOutput.length > 200) this.recentOutput.shift()
      // Remember the latest room name / description chunks (see stickyRoom* above).
      // Name rides the room streamWindow's " - <Room>" subtitle (or a room-name
      // component); description is the room-desc component.
      if (/subtitle=['"] - /.test(r) || /id=['"]room name['"]/.test(r)) this.stickyRoomName = r
      if (/id=['"]room desc['"]/.test(r)) this.stickyRoomDesc = r
      this.emit('game:data', r)
      this.cmdEngine.feed(r)
      this.triggers.feed(r)   // server-side alert eval → push
      if (log.isEnabled()) for (const line of stripToLines(r)) log.writeLine(line)
      if (!this.lichReadyDetected) {
        const charMatch = /<app[^>]+char=["']([^"']+)["']/.exec(r)
        if (charMatch) {
          this.lichReadyDetected = true
          this.charName = charMatch[1]
          this.applyLogging(charMatch[1])   // per-character log file + flag
          this.cmdEngine.setContext({ charname: charMatch[1] })
          this.lichLog('[lich] Character data received -- Lich ready')
          this.emit('lich:status', 'ready')
          this.syncPresence()   // Lich sessions learn the name here (after 'connected')
        }
      }
    })
  }

  /** Broadcast an event to EVERY attached client (multi-viewer / watch mode). */
  private emit(channel: string, ...args: unknown[]): void {
    for (const c of this.clients) c(channel, ...args)
  }

  /**
   * Attach a client (WebSocket) and replay current state to IT ONLY (not the others),
   * then return a detach fn. `replayOutput` re-sends the recent game scrollback — set
   * for a WATCH attach (a fresh viewer that needs context), but not for an ordinary
   * reconnect of the session's own client, which would just duplicate its output.
   */
  addClient(emit: Emit, replayOutput = false): () => void {
    this.clients.add(emit)
    for (const line of this.lichLogBuffer) emit('lich:log', line)
    emit(this.gameConn.getStatus() === 'connected' ? 'game:connected' : 'game:disconnected')
    emit('lich:status', this.lichMgr.getStatus())
    // Repopulate the sticky room name/description for EVERY attaching client — a
    // fresh watcher, or our own client after a reload — since these aren't carried
    // by the frequently-refreshed recentOutput. De-duped in case one chunk held both.
    // Sent before the scrollback so any newer objs/exits in it still layer on top.
    const seen = new Set<string>()
    for (const chunk of [this.stickyRoomName, this.stickyRoomDesc]) {
      if (chunk && !seen.has(chunk)) { seen.add(chunk); emit('game:data', chunk) }
    }
    if (replayOutput) for (const r of this.recentOutput) emit('game:data', r)
    return () => { this.clients.delete(emit) }
  }

  /** True while any client is attached; the gateway starts the grace/keepalive timer
   *  only once the last one detaches. */
  hasClients(): boolean { return this.clients.size > 0 }

  /** How many clients/devices are attached (for the metrics dashboard). */
  clientCount(): number { return this.clients.size }

  /** The connected character's name (for the watch-session picker labels). */
  getCharName(): string { return this.charName }

  /** Whether the DR game socket is live — the gateway keeps abandoned sessions
   *  alive (so push keeps firing and a reopened app resumes) only while this holds. */
  isGameConnected(): boolean { return this.gameConn.getStatus() === 'connected' }

  /** Push an event to every client attached to this session (all of a character's
   *  devices). The MessageHub calls this to deliver cross-session messages/presence. */
  deliver(channel: string, ...args: unknown[]): void { this.emit(channel, ...args) }

  /** Web-push an incoming Magiloom message to this character's devices — but only when
   *  the app is CLOSED (no client attached), since an open app gets the in-app toast.
   *  Gated by the user's push opt-in (Settings → Notifications → Direct messages). The
   *  MessageHub calls this on the recipient's session(s). Mirrors trigger-engine's
   *  conversation push, keyed to this user so only their devices are pinged. */
  maybePushMessage(fromName: string, body: string): void {
    if (this.hasClients()) return
    const push = (this.user.settings.getAll() as unknown as { push?: PushConfig }).push
    if (!push?.enabled || !push.message) return
    const text = body.length > 140 ? body.slice(0, 139) + '…' : body
    void notify({ title: `Message from ${fromName}`, body: text, tag: 'msg-' + fromName.toLowerCase() }, this.user.userId)
  }

  // The character name currently registered with the MessageHub (empty = offline for
  // messaging). Tracked separately from charName so a name change or a disconnect
  // re-points presence correctly.
  private registeredName = ''

  /** Keep the messaging presence registry in step with this session's identity: a
   *  character is "online" for messaging exactly while its game socket is up under a
   *  known name. Safe to call repeatedly (connect, character detected, disconnect). */
  private syncPresence(): void {
    const name = this.isGameConnected() ? this.charName : ''
    if (name === this.registeredName) return
    if (this.registeredName) this.server.hub.deregister(this.registeredName, this)
    this.registeredName = name
    if (name) this.server.hub.register(name, this)
  }

  // ── Request/response router (mirrors every ipcMain.handle) ───────────────────
  async invoke(channel: string, args: unknown[]): Promise<unknown> {
    const s = this.user.settings
    const a = args as unknown[]
    switch (channel) {
      // app / window / updater — desktop-only chrome; harmless no-ops on server
      case 'app:version':        return process.env['MAGILOOM_VERSION'] ?? '0.0.0'
      case 'app:open-external':  return
      case 'window:minimize':
      case 'window:maximize':
      case 'window:close':       return
      case 'window:is-maximized': return false
      case 'updater:check':
      case 'updater:install':    return

      // settings
      case 'settings:get-all':   return s.getAll()
      case 'settings:patch': {
        const p = a[0] as Record<string, unknown> | undefined
        s.patch(p ?? {})
        return
      }
      case 'settings:get-char':   return s.getCharSettings(a[0] as string)
      case 'settings:patch-char': {
        const name = a[0] as string
        const partial = a[1] as Record<string, unknown> | undefined
        s.patchCharSettings(name, partial as never)
        // Toggling logging takes effect immediately, but only for the character
        // this session is actually playing — saving settings for another of the
        // user's characters (or from another device) must not touch this log.
        if (partial && 'logging' in partial && this.log.currentChar() === logSlug(name)) {
          this.log.setEnabled(s.getCharSettings(name).logging)
        }
        return
      }

      // game logs — the PWA's only way to reach them (they live on the server).
      // Confined to this user's logs/ dir and name-jailed in log-store.ts.
      case 'logs:list': return this.log.listFiles()
      case 'logs:read': return this.log.readFile(a[0] as string)

      // avatars / portraits
      case 'avatar:enabled': return isAvatarServiceEnabled()
      case 'avatar:get':     return getAvatar(a[0] as string)
      case 'avatar:publish': return publishAvatar(s, a[0] as string, a[1] as string)
      case 'avatar:delete':  return deleteAvatar(s, a[0] as string)
      case 'portrait:generate': return ensurePortrait(a[0] as string, a[1] as string)

      // auth / passwords
      case 'auth:save-password': {
        if (!isEncryptionAvailable()) return
        s.savePassword(a[0] as string, encryptString(a[1] as string))
        return
      }
      case 'auth:get-password': {
        const b64 = s.getPasswordB64(a[0] as string)
        return b64 ? decryptString(b64) : null
      }
      case 'auth:forget-password': return s.forgetPassword(a[0] as string)
      case 'auth:forget-account':  return s.forgetAccount(a[0] as string)
      case 'auth:login':            return this.login(a[0] as string, a[1] as string)
      case 'auth:select-instance':  return this.selectInstance(a[0] as string)
      case 'auth:select-character': return this.selectCharacter(a[0] as string, a[1] as string, a[2] as string, a[3] as boolean | undefined)

      // lich
      case 'lich:get-log':     return this.lichLogBuffer.slice()
      // On the server, Lich availability is the shared install, not a local path —
      // report its lich.rbw so the client's "Connect with Lich" toggle knows.
      case 'lich:detect-path': { const r = sharedLichRoot(); return r ? join(r, 'lich.rbw') : '' }
      case 'lich:stop':        this.stopLich(); return
      case 'lich:launch-sidecar':
        return { ok: false, error: 'Use the Lich path in Settings to enable Lich at login.' }

      // lich file management — the PWA uploads/edits setup.yaml + custom scripts.
      // Confined to this user's profiles/ + custom/ dirs (see lich-files.ts).
      case 'lich:list-files':  return listFiles(this.userScriptsDir())
      case 'lich:read-file':   return readFile(this.userScriptsDir(), a[0] as string)
      case 'lich:write-file':  return writeFile(this.userScriptsDir(), a[0] as string, a[1] as string)
      case 'lich:delete-file': return deleteFile(this.userScriptsDir(), a[0] as string)

      // native .cmd script engine
      case 'script:list':        return this.cmdEngine.list()
      case 'script:running':     return this.cmdEngine.running()
      case 'script:default-dir': return join(this.user.dir, 'scripts')
      case 'script:run':         return this.cmdEngine.run(a[0] as string, (a[1] as string[]) ?? [])
      case 'script:stop':        return this.cmdEngine.stop(a[0] as number | undefined)

      // file/folder pickers — no native dialog on a headless server / mobile client
      case 'dialog:choose-folder':
      case 'dialog:choose-file':
      case 'dialog:open-text-file':
        return null

      // game
      case 'game:get-status': return this.gameConn.getStatus()
      case 'game:disconnect': return this.gameConn.disconnect()
      case 'game:send': {
        this.gameConn.send(a[0] as string)
        this.emit('game:sent', a[0] as string)
        return
      }

      // broadcast bus (multi-boxing / link) — per user, not server-wide
      case 'broadcast:send':        return this.user.broadcast.send(a[0] as string)
      case 'broadcast:set-receive': return this.user.broadcast.setReceive(a[0] as boolean)

      // ── Magiloom messaging (character-to-character; separate from in-game speech) ──
      // The actor is ALWAYS the authenticated character name (this.charName) — never
      // taken from args — so a client can only ever act as the character it logged in
      // to SGE as. Rejected until a character is connected.
      case 'contacts:list':
      case 'contacts:add':
      case 'contacts:accept':
      case 'contacts:deny':
      case 'contacts:remove':
      case 'msg:history':
      case 'msg:mark-read':
      case 'msg:send': {
        const self = this.charName
        if (!self) throw new Error('Not connected as a character.')
        const hub = this.server.hub
        switch (channel) {
          case 'contacts:list':   return hub.contacts(self)
          case 'contacts:add':    return hub.requestContact(self, a[0] as string)
          case 'contacts:accept': return hub.acceptContact(self, a[0] as string)
          case 'contacts:deny':   return hub.denyContact(self, a[0] as string)
          case 'contacts:remove': return hub.removeContact(self, a[0] as string)
          case 'msg:history':     return hub.history(self, a[0] as string)
          case 'msg:mark-read':   return hub.markRead(self, a[0] as string)
          case 'msg:send':        return hub.send(self, a[0] as string, a[1] as string)
        }
        return
      }

      // automapper (shared world map)
      case 'map:load':        return this.server.map.loadAll()
      case 'map:save-zone':   return this.server.map.saveZone(a[0] as StoredZone)
      case 'map:delete-zone': return this.server.map.deleteZone(a[0] as string)
      case 'map:clear':       return this.server.map.clearAll()
      case 'map:export':      return { ok: false, error: 'Export happens client-side on the web build.' }

      default:
        throw new Error(`Unknown channel: ${channel}`)
    }
  }

  // ── SGE auth flow (mirrors the three auth ipc handlers) ──────────────────────
  private async login(account: string, password: string): Promise<unknown> {
    const result = await sgeAuth(account, password, (l) => this.lichLog('[sge] ' + l))
    if (!result.ok) return result
    this.pendingSelectInstance = result.selectInstance
    this.loginPassword = password   // consumed by headless Lich in selectCharacter
    this.user.settings.saveAccount(account)
    return { ok: true, instances: result.instances }
  }

  private async selectInstance(code: string): Promise<unknown> {
    if (!this.pendingSelectInstance) return { ok: false, error: 'Session expired.' }
    const result = await (this.pendingSelectInstance as (c: string) => Promise<{
      ok: boolean; error?: string; characters?: unknown[]
      selectCharacter?: (id: string) => Promise<SGELaunchKey>
    }>)(code)
    if (!result.ok) return result
    this.pendingSelectCharacter = result.selectCharacter ?? null
    return { ok: true, characters: result.characters }
  }

  private async selectCharacter(
    characterId: string, characterName: string, accountName: string, useLich?: boolean,
  ): Promise<unknown> {
    if (!this.pendingSelectCharacter) return { ok: false, error: 'Session expired.' }
    let key: SGELaunchKey
    try {
      key = await this.pendingSelectCharacter(characterId)
    } catch (e) {
      return { ok: false, error: String(e) }
    }
    this.pendingSelectCharacter = null
    this.user.settings.saveAccount(accountName, characterName)
    this.lichReadyDetected = false
    this.charName = characterName
    // Direct (non-Lich) connections never hit the <app char=…> branch in
    // wireEvents, so resolve this character's logging flag here; for Lich
    // sessions the same call runs again once Lich reports the character.
    this.applyLogging(characterName)

    // The "Connect with Lich" login toggle decides this per session; when omitted
    // (older client) fall back to the prior opt-in (the lichPath setting). The
    // engine itself comes from the shared install via the provisioner.
    const wantsLich = useLich ?? !!this.user.settings.get('lichPath')
    this.user.settings.patch({ connectWithLich: wantsLich } as never)
    const home = wantsLich ? provisionLichHome(this.server.dataDir, this.user.userId) : null

    if (home) {
      this.stopLich()
      if (process.env['MAGILOOM_LICH_FROSTBITE'] === '1') {
        // Legacy single-instance path: Lich's frostbite `-g` listener is hardwired
        // to 127.0.0.1:11024, so only ONE can run per container. Gate to that slot
        // and connect any extra session directly. Kept as a fallback in case the
        // headless path misbehaves against a given Lich build.
        const port = this.server.ports.acquirePrimary()
        if (port === null) {
          this.lichLog('[sge] Another Lich session is already active on this server — connecting this character directly.')
          this.emit('lich:status', 'stopped')
          this.gameConn.connectDirect(key.host, key.port, key.key)
          return { ok: true, lich: false, lichBusy: true }
        }
        this.lichPort = port
        this.lichLog(`[sge] Launching Lich (frostbite mode, port ${this.lichPort}) for ${characterName}...`)
        this.lichMgr.spawnOnly(key.host, key.port, home.lichRbw, this.lichPort, {
          home: home.home, lib: home.lib, scripts: home.scripts,
        })
        this.lichLog(`[sge] Connecting to Lich on port ${this.lichPort}...`)
        this.gameConn.connectWithKey('127.0.0.1', this.lichPort, key.key)
      } else if (!this.loginPassword) {
        // Headless Lich self-logs-in from entry.yaml, which needs the password we
        // only hold during the login flow. Missing (e.g. a resumed session) → direct.
        this.lichLog('[sge] No password available for headless Lich; connecting directly.')
        this.emit('lich:status', 'stopped')
        this.gameConn.connectDirect(key.host, key.port, key.key)
        return { ok: true, lich: false }
      } else {
        // Headless/broker mode (default): Lich authenticates itself and exposes a
        // unique detachable port, so any number of characters run Lich at once.
        writeLichEntry(home.home, accountName, this.loginPassword, characterName)
        this.loginPassword = null
        this.lichPort = this.server.ports.acquire()
        this.lichLog(`[sge] Launching Lich (headless mode, port ${this.lichPort}) for ${characterName}...`)
        this.lichMgr.spawnHeadless(characterName, this.lichPort, home.lichRbw, {
          home: home.home, lib: home.lib, scripts: home.scripts,
        })
        this.lichLog(`[sge] Attaching to Lich detachable client on port ${this.lichPort}...`)
        this.gameConn.connect('127.0.0.1', this.lichPort)
      }
    } else {
      if (wantsLich) {
        this.lichLog('[sge] Lich requested but no shared install found — connecting directly.')
      }
      this.lichLog('[sge] Connecting directly to ' + key.host + ':' + key.port)
      this.gameConn.connectDirect(key.host, key.port, key.key)
    }
    return { ok: true }
  }

  /** Ensure this user's writable Lich dirs exist and return their scripts dir. */
  private userScriptsDir(): string {
    return ensureUserScriptsDir(this.server.dataDir, this.user.userId)
  }

  /** Stop Lich and return its port to the pool. */
  private stopLich(): void {
    this.lichMgr.stop()
    this.lichConn.disconnect()
    if (this.lichPort !== null) { this.server.ports.release(this.lichPort); this.lichPort = null }
  }

  /** Tear down per-session resources (mirrors window-all-closed for one window). */
  dispose(): void {
    if (this.registeredName) { this.server.hub.deregister(this.registeredName, this); this.registeredName = '' }
    this.loginPassword = null
    this.cmdEngine.stop()
    this.gameConn.disconnect()
    this.stopLich()
  }
}
