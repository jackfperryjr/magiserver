import { join } from 'path'
import { LichManager, LichConnection } from './lib/lich-manager'
import { GameConnection } from './lib/game-connection'
import { CmdScriptEngine } from './lib/cmd-script-engine'
import { MapStore, type StoredZone } from './lib/map-store'
import { stripToLines } from './lib/log-store'
import { sgeAuth, type SGELaunchKey } from './lib/sge-auth'
import {
  getAvatar, publishAvatar, deleteAvatar, isAvatarServiceEnabled,
} from './lib/avatar-service'
import { ensurePortrait } from './lib/portrait-service'
import { encryptString, decryptString, isEncryptionAvailable } from './crypto'
import type { UserContext } from './user-context'
import type { PortAllocator } from './port-allocator'
import { TriggerEngine, DEFAULT_PUSH, type NotifRule, type PushConfig } from './trigger-engine'
import { provisionLichHome, ensureUserScriptsDir, sharedLichRoot } from './lich-home'
import { listFiles, readFile, writeFile, deleteFile } from './lich-files'

/** Sends an event to the connected client (replaces mainWindow.webContents.send). */
export type Emit = (channel: string, ...args: unknown[]) => void

/** Server-global singletons injected into every session. */
export interface ServerContext {
  map: MapStore          // shared community world-map (see user-context.ts)
  ports: PortAllocator   // Lich frontend-port pool (multi-instance support)
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

  private charName = ''
  private lichPort: number | null = null   // allocated only while Lich is running

  // Per-session SGE login continuation (each user logs in independently).
  private pendingSelectInstance:  ((code: string) => Promise<unknown>) | null = null
  private pendingSelectCharacter: ((id: string) => Promise<SGELaunchKey>) | null = null
  private lichReadyDetected = false

  constructor(
    private readonly user: UserContext,
    private readonly server: ServerContext,
    private emit: Emit,
  ) {
    const s = this.user.settings
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

  private lichLog(line: string): void {
    this.lichLogBuffer.push(line)
    if (this.lichLogBuffer.length > 200) this.lichLogBuffer.shift()
    this.emit('lich:log', line)
  }

  // ── Event wiring (mirrors setupIpcHandlers' *.on(...) blocks) ────────────────
  private wireEvents(): void {
    const { broadcast, log } = this.user
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
    this.gameConn.on('connected',    () => { this.lichLog('[game] Connected'); this.emit('game:connected') })
    this.gameConn.on('disconnected', () => { this.lichLog('[game] Disconnected'); this.emit('game:disconnected') })
    this.gameConn.on('error',        (e: string) => { this.lichLog('[game] Error: ' + e); this.emit('game:error', e) })
    this.gameConn.on('data',         (r: string) => {
      this.emit('game:data', r)
      this.cmdEngine.feed(r)
      this.triggers.feed(r)   // server-side alert eval → push
      if (log.isEnabled()) for (const line of stripToLines(r)) log.writeLine(line)
      if (!this.lichReadyDetected) {
        const charMatch = /<app[^>]+char=["']([^"']+)["']/.exec(r)
        if (charMatch) {
          this.lichReadyDetected = true
          this.charName = charMatch[1]
          log.setChar(charMatch[1])
          this.cmdEngine.setContext({ charname: charMatch[1] })
          this.lichLog('[lich] Character data received -- Lich ready')
          this.emit('lich:status', 'ready')
        }
      }
    })
  }

  /** Rebind event output to a new WebSocket after a reconnect (see gateway.ts). */
  setEmit(emit: Emit): void { this.emit = emit }

  /** Replay state a freshly-(re)connected client needs (mirrors did-finish-load). */
  replayInitialState(): void {
    for (const line of this.lichLogBuffer) this.emit('lich:log', line)
    this.emit(this.gameConn.getStatus() === 'connected' ? 'game:connected' : 'game:disconnected')
    this.emit('lich:status', this.lichMgr.getStatus())
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
        if (p && 'logging' in p) this.user.log.setEnabled(!!p.logging)
        return
      }
      case 'settings:get-char':   return s.getCharSettings(a[0] as string)
      case 'settings:patch-char': return s.patchCharSettings(a[0] as string, a[1] as never)

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

    // The "Connect with Lich" login toggle decides this per session; when omitted
    // (older client) fall back to the prior opt-in (the lichPath setting). The
    // engine itself comes from the shared install via the provisioner.
    const wantsLich = useLich ?? !!this.user.settings.get('lichPath')
    this.user.settings.patch({ connectWithLich: wantsLich } as never)
    const home = wantsLich ? provisionLichHome(this.server.dataDir, this.user.userId) : null

    if (home) {
      // Allocate a unique frontend port so multiple users' Lich instances don't
      // collide on 11024, and launch against this user's isolated home.
      this.stopLich()
      this.lichPort = this.server.ports.acquire()
      this.lichLog(`[sge] Launching Lich (frostbite mode, port ${this.lichPort}) for ${characterName}...`)
      this.lichMgr.spawnOnly(key.host, key.port, home.lichRbw, this.lichPort, {
        home: home.home, lib: home.lib, scripts: home.scripts,
      })
      this.lichLog(`[sge] Connecting to Lich on port ${this.lichPort}...`)
      this.gameConn.connectWithKey('127.0.0.1', this.lichPort, key.key)
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
    this.cmdEngine.stop()
    this.gameConn.disconnect()
    this.stopLich()
  }
}
