import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { createConnection, Socket } from 'net'

export type LichStatus = 'stopped' | 'starting' | 'ready' | 'error'

export class LichManager extends EventEmitter {
  private process:   ChildProcess | null = null
  private status:    LichStatus = 'stopped'
  private pollTimer: ReturnType<typeof setInterval> | null = null
  // Home dir of the current launch, so a failed exit can surface Lich's own log
  // files — running --without-frontend, Lich sends its real errors there, not to
  // the stdout/stderr we capture (hence the otherwise-"silent" exits).
  private lichHome:  string | null = null

  getLichPath(override?: string): string {
    if (override && existsSync(override)) return override
    const home = process.env['HOME'] || process.env['USERPROFILE'] || ''
    const candidates = [
      'C:\\Ruby4Lich5\\Lich5\\lich.rbw',
      join('C:\\', 'Ruby4Lich5', 'Lich5', 'lich.rbw'),
      join(home, 'Desktop', 'Lich5', 'lich.rbw'),
      'C:\\lich5\\lich.rbw',
      join(home, 'lich5', 'lich.rbw'),
      join(home, 'lich5', 'lich.rb'),
    ]
    return candidates.find(existsSync) ?? ''
  }

  getRubyPath(): string {
    const candidates = [
      'C:\\Ruby4Lich5\\4.0.0\\bin\\ruby.exe',
      'C:\\Ruby4Lich5\\bin\\ruby.exe',
      'C:\\Ruby31\\bin\\ruby.exe',
      'ruby',
    ]
    return candidates.find(p => p === 'ruby' || existsSync(p)) ?? 'ruby'
  }

  /**
   * Spawn Lich and immediately start gameConn retrying its proxy port.
   * Lich opens port 11024 within ~2-3s; the retry loop catches it.
   * No polling here — the caller (index.ts) drives the connection.
   */
  /**
   * Spawn Lich using --frostbite -g host:port, exactly like Frostbite does.
   * No --login, no entry.yaml — Lich connects to the game server directly
   * using the host:port we provide from our SGE auth.
   *
   * `listenPort` is the frontend port our GameConnection then attaches to. It
   * defaults to 11024 (the single-session default — behaviour identical to the
   * desktop app). Pass a unique port per session to run multiple Lich instances
   * concurrently; see server/src/port-allocator.ts.
   *
   * MULTI-INSTANCE CAVEAT: in the default single-session path (listenPort 11024)
   * Lich listens on its built-in frostbite port and this is battle-tested. For a
   * custom port we add `--detachable-client=<port>` so Lich listens there instead;
   * that flag is proven in Lich's script mode but the frostbite + custom-port combo
   * needs verification against your Lich build. If it misbehaves, the robust
   * alternative is full detachable-client broker mode (let Lich own the game login
   * instead of forwarding our SGE key). Kept opt-in so the default stays safe.
   */
  spawnOnly(
    gameHost: string,
    gamePort: number,
    lichPathOverride?: string,
    listenPort = 11024,
    dirs?: { home?: string; lib?: string; scripts?: string }
  ): { ok: boolean; error?: string } {
    if (this.process) this.stop()

    const lichPath = this.getLichPath(lichPathOverride)
    if (!lichPath) {
      this.setStatus('error')
      return { ok: false, error: 'Lich not found. Set the path in Settings.' }
    }

    const rubyPath = this.getRubyPath()

    const args = [
      lichPath,
      '--dragonrealms',
      '--frostbite',
      `-g`, `${gameHost}:${gamePort}`,
    ]
    // Per-user Lich home: isolate this user's data/scripts/profiles while sharing
    // the read-only engine (--lib) and community library (symlinked into scripts).
    // See lich-home.ts. Omitted → Lich uses its install-relative default dirs.
    if (dirs?.home)    args.push(`--home=${dirs.home}`)
    if (dirs?.lib)     args.push(`--lib=${dirs.lib}`)
    if (dirs?.scripts) args.push(`--scripts=${dirs.scripts}`)
    // Only override the listen port when asked, so the default single-session
    // path is byte-for-byte the desktop app's proven invocation.
    if (listenPort !== 11024) args.push(`--detachable-client=${listenPort}`)

    this.emit('log', `Launching Lich: ${rubyPath} ${args.join(' ')}`)
    this.setStatus('starting')
    this._spawn(rubyPath, args)

    // Signal ready after 8s — gives Lich time to connect to game and parse
    // the initial XML (character name, vitals etc) before scripts start running
    setTimeout(() => {
      if (this.status === 'starting') {
        this.setStatus('ready')
        this.emit('ready', listenPort)
      }
    }, 8000)

    return { ok: true }
  }

  /**
   * Launch Lich fully headless: it self-authenticates from its saved entry.yaml
   * (see lich-home.ts writeLichEntry) via `--login <Char>`, connects to the game
   * itself, and exposes a detachable client on `listenPort` via `--without-frontend
   * --detachable-client=PORT` (Lich's documented headless combo). No primary frontend
   * and no fixed 127.0.0.1:11024 listener, so any number of sessions coexist — each
   * on its own port. The caller's GameConnection attaches to `listenPort` with a
   * plain connect (no key/handshake); Lich streams XML to it.
   *
   * Flag history: `--headless=PORT` is NOT a real Lich flag — Lich ignored it and ran
   * its GTK frontend, which (a) demanded the gtk3 gem and (b) never opened an attach
   * port. gtk3 is now installed and Lich runs under xvfb-run (it calls Gtk.init even
   * with no frontend — see _spawn), so these documented flags open the port headlessly.
   */
  spawnHeadless(
    characterName: string,
    listenPort: number,
    lichPathOverride?: string,
    dirs?: { home?: string; lib?: string; scripts?: string }
  ): { ok: boolean; error?: string } {
    if (this.process) this.stop()

    const lichPath = this.getLichPath(lichPathOverride)
    if (!lichPath) {
      this.setStatus('error')
      return { ok: false, error: 'Lich not found. Set the path in Settings.' }
    }
    const rubyPath = this.getRubyPath()

    // Credentials are NOT on the command line — they live in entry.yaml — so the
    // launch line is safe to log verbatim.
    const args = [
      lichPath,
      '--dragonrealms',
      '--login', characterName,
      '--without-frontend',
      `--detachable-client=${listenPort}`,
    ]
    if (dirs?.home)    args.push(`--home=${dirs.home}`)
    if (dirs?.lib)     args.push(`--lib=${dirs.lib}`)
    if (dirs?.scripts) args.push(`--scripts=${dirs.scripts}`)

    this.emit('log', `Launching Lich (headless, port ${listenPort}): ${rubyPath} ${args.join(' ')}`)
    this.setStatus('starting')
    this.lichHome = dirs?.home ?? null
    this._spawn(rubyPath, args)

    // Lich self-login (SGE + game connect) then opens the detachable port; the
    // GameConnection retry loop attaches once it's up. Signal ready after 8s like
    // spawnOnly so scripts don't start before the initial XML is parsed.
    setTimeout(() => {
      if (this.status === 'starting') {
        this.setStatus('ready')
        this.emit('ready', listenPort)
      }
    }, 8000)

    return { ok: true }
  }

  /**
   * Launch Lich in detachable-client mode for script execution only.
   * Uses port polling since this mode doesn't broker the game connection.
   */
  launchForScripts(
    characterName: string,
    lichPathOverride?: string,
    port = 4901
  ): { ok: boolean; error?: string } {
    if (this.status === 'starting' || this.status === 'ready') return { ok: true }
    if (this.process) this.stop()

    const lichPath = this.getLichPath(lichPathOverride)
    if (!lichPath) {
      this.setStatus('error')
      return { ok: false, error: 'Lich not found. Set the path in Settings.' }
    }

    const rubyPath = this.getRubyPath()

    const args = [
      lichPath,
      `--detachable-client=${port}`,
      '--without-frontend',
      '--dragonrealms',
    ]

    this.emit('log', `Launching Lich (script mode): ${rubyPath} ${args.join(' ')}`)
    this.setStatus('starting')
    this._spawn(rubyPath, args)
    this._pollPort(port)
    return { ok: true }
  }

  stop(): void {
    this.clearPoll()
    this.process?.kill('SIGTERM')
    this.process = null
    this.setStatus('stopped')
  }

  getStatus(): LichStatus { return this.status }

  private _spawn(rubyPath: string, args: string[]): void {
    // Lich 5 calls Gtk.init at startup even with no frontend (no headless bypass
    // exists), so on Linux it needs an X display a server doesn't have. Run it under
    // xvfb-run, which spins up a throwaway virtual display; `-a` auto-picks a free
    // display number so concurrent Lich processes never collide. Other platforms
    // (dev on Windows/macOS) launch ruby directly — they have a real display.
    const [cmd, cmdArgs] = process.platform === 'linux'
      ? ['xvfb-run', ['-a', rubyPath, ...args]]
      : [rubyPath, args]
    this.process = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stdin?.end()

    // Lich's own logging (Lich.log) goes to STDERR, so this is where the "why did
    // it quit" detail lives. Keep a tail so we can replay it on exit — a fast/quiet
    // exit can flush its final stderr AFTER the 'exit' event, which would otherwise
    // be lost.
    const tail: string[] = []
    const record = (l: string) => { tail.push(l); if (tail.length > 80) tail.shift() }

    this.process.stdout?.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(l => { record(l); this.emit('log', l) })
    })
    this.process.stderr?.on('data', (d: Buffer) => {
      d.toString().split('\n').filter(Boolean).forEach(l => {
        record(`[stderr] ${l}`)
        this.emit('log', `[stderr] ${l}`)
        if (/error|failed|invalid|no such|cannot/i.test(l) && this.status !== 'ready') {
          this.setStatus('error')
          this.emit('error', l.trim())
        }
      })
    })

    // Record the exit code, but do the diagnostic on 'close' — it fires only after
    // stdout/stderr have fully drained, so we never miss Lich's final words.
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    this.process.on('exit', (code, signal) => { exited = { code, signal }; this.clearPoll() })
    this.process.on('close', () => {
      if (this.status === 'ready') { this.setStatus('stopped'); this.process = null; return }
      const code = exited?.code ?? null
      const signal = exited?.signal ?? null
      const reason = signal
        ? `terminated by signal ${signal}`
        : code !== null ? `exited with code ${code}` : 'terminated unexpectedly'
      // Replay everything Lich printed so the exit is diagnosable from the client.
      if (tail.length) {
        this.emit('log', '[lich] ── Lich output before exit ──')
        for (const l of tail) this.emit('log', l)
        this.emit('log', '[lich] ── end Lich output ──')
      } else {
        this.emit('log', '[lich] Lich produced no output on stdout/stderr — checking its log files…')
      }
      // Headless Lich logs to files, not the pipes above; surface the newest so a
      // silent exit is actually diagnosable.
      this.emitLichLogTail()
      this.emit('log', `[lich] Process ${reason}`)
      this.setStatus('error')
      this.emit('error', `Lich ${reason}. Check the log for details.`)
      this.process = null
    })
  }

  // After a failed launch, emit the tail of Lich's newest log file. Headless Lich
  // (--without-frontend) routes its real errors — bad saved login, a Ruby-4 crash,
  // a GTK/display problem — to files under its home (logs/, temp/, or Lich.log at
  // the root), never to the stdout/stderr we pipe, so those exits look "silent".
  private emitLichLogTail(): void {
    const home = this.lichHome
    if (!home) return
    const dirs = [join(home, 'logs'), join(home, 'temp'), home]
    let newest: { path: string; mtime: number } | null = null
    for (const d of dirs) {
      let names: string[]
      try { names = readdirSync(d) } catch { continue }
      for (const name of names) {
        if (!/\.(log|txt)$/i.test(name)) continue
        try {
          const p = join(d, name)
          const st = statSync(p)
          if (st.isFile() && (!newest || st.mtimeMs > newest.mtime)) newest = { path: p, mtime: st.mtimeMs }
        } catch { /* skip unreadable */ }
      }
    }
    if (!newest) { this.emit('log', '[lich] No Lich log file found to report.'); return }
    try {
      const lines = readFileSync(newest.path, 'utf8').split(/\r?\n/).filter(Boolean)
      const tail = lines.slice(-40)
      this.emit('log', `[lich] ── ${newest.path} (last ${tail.length} lines) ──`)
      for (const l of tail) this.emit('log', `[lichlog] ${l}`)
      this.emit('log', '[lich] ── end lich log ──')
    } catch { this.emit('log', `[lich] Could not read ${newest.path}.`) }
  }

  private _pollPort(port: number): void {
    this.clearPoll()
    let attempts = 0
    this.pollTimer = setInterval(() => {
      attempts++
      if (attempts % 30 === 0) {
        this.emit('log', `[lich] Still waiting for Lich to start… (${attempts}s elapsed)`)
      }
      if (attempts > 300) {
        this.clearPoll()
        this.setStatus('error')
        this.emit('error', 'Timed out waiting for Lich scripting port (5 min).')
        return
      }
      const s = createConnection({ port, host: '127.0.0.1' })
      s.on('connect', () => {
        s.destroy()
        this.clearPoll()
        this.setStatus('ready')
        this.emit('ready', port)
      })
      s.on('error', () => s.destroy())
    }, 1000)
  }

  private setStatus(s: LichStatus) {
    this.status = s
    this.emit('status', s)
  }

  private clearPoll(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
  }
}

// ── LichConnection ─────────────────────────────────────────────────────────────
export class LichConnection extends EventEmitter {
  private socket: Socket | null = null

  connect(port = 4901): void {
    if (this.socket) { this.socket.destroy(); this.socket = null }
    const s = new Socket()
    s.setEncoding('latin1')
    s.on('connect', () => { this.socket = s; this.emit('connected') })
    s.on('close',   () => { this.socket = null })
    s.on('error',   () => { this.socket = null })
    s.connect(port, '127.0.0.1')
  }

  send(cmd: string): boolean {
    if (!this.socket || this.socket.destroyed) return false
    this.socket.write(cmd.endsWith('\n') ? cmd : cmd + '\n', 'latin1')
    return true
  }

  isConnected(): boolean {
    return !!(this.socket && !this.socket.destroyed)
  }

  disconnect(): void {
    this.socket?.destroy()
    this.socket = null
  }
}
