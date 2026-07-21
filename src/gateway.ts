import type { Server as HttpServer } from 'http'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { Session, type ServerContext } from './session'
import type { UserRegistry } from './user-context'
import type { AccountStore } from './accounts'

// ── Wire protocol ──────────────────────────────────────────────────────────────
// A tiny JSON envelope that mirrors Electron's IPC:
//   client → server:  { t:'invoke', id, channel, args }   (like ipcRenderer.invoke)
//   server → client:  { t:'result', id, ok, result|error }
//   server → client:  { t:'event',  channel, args }        (like webContents.send)
//
// The renderer's WebSocket `dr.*` transport (step 2) speaks exactly this: each
// dr.foo.bar(...args) becomes an `invoke`, and each dr.foo.onX(cb) subscribes to
// the matching `event` channel.

interface InvokeMsg { t: 'invoke'; id: number; channel: string; args?: unknown[] }

const token = process.env['MAGILOOM_TOKEN'] ?? ''

// How long to keep a user's game session (and its live connection to DR) alive
// after their WebSocket drops, so a backgrounded/minimized app or a network blip
// can reconnect and resume instead of dropping the character. Tunable via env.
const GRACE_MS = Number(process.env['MAGILOOM_SESSION_GRACE_MS'] ?? 5 * 60 * 1000)

// How long to keep an ABANDONED session (no client attached) alive while its DR
// connection is still up — so a backgrounded/closed PWA keeps its character online
// and server-side push keeps firing, and reopening the app resumes the same session
// ("watch" it). Bounded so a truly-gone client eventually frees its DR socket. When
// DR itself has already dropped, we fall back to the short GRACE_MS (nothing to keep).
const KEEPALIVE_MS = Number(process.env['MAGILOOM_SESSION_KEEPALIVE_MS'] ?? 2 * 60 * 60 * 1000)
const KEEPALIVE_POLL_MS = 60 * 1000

interface LiveSession {
  session: Session
  grace: ReturnType<typeof setTimeout> | null
  detachedAt: number | null   // when the last client dropped (null while attached)
  keepAlive: boolean          // paid: hold across client absence; free: short grace
  createdAt: number           // when this session first attached (for uptime/metrics)
}

// ── Live metrics (for /stats + the /admin dashboard) ─────────────────────────────
/** One session's line in the admin dashboard. Character names are included for the
 *  OPERATOR's view only — they never appear in the public /stats aggregate. */
export interface SessionStat {
  charName:      string
  gameConnected: boolean
  clients:       number    // attached devices/watchers
  paid:          boolean
  detached:      boolean   // no client attached right now (in grace/keepalive)
  connectedAt:   number
}
export interface GatewaySnapshot {
  online:        number    // distinct characters with a live game connection ("playing now")
  playing:       number    // sessions with a live game connection
  connections:   number    // total attached clients across all sessions
  totalSessions: number    // sessions held (incl. detached-but-alive)
  sessions:      SessionStat[]
}
/** A gateway exposes a live snapshot of its sessions for the metrics endpoints. */
export interface GatewayHandle { snapshot(): GatewaySnapshot }

/** Extra fields we stash on the upgrade request to carry into the connection. */
interface ConnReq {
  magiloomUser?: string; magiloomKey?: string; magiloomPaid?: boolean; magiloomWatch?: boolean
}

/** Attach the game WebSocket gateway at /ws on an existing HTTP server.
 *  `accounts` is passed only when MAGILOOM_ACCOUNTS_ENABLED — otherwise null and
 *  the account-identity path below is inert (device-keyed behaviour, unchanged). */
export function attachGateway(
  httpServer: HttpServer,
  registry: UserRegistry,
  server: ServerContext,
  accounts: AccountStore | null = null,
): GatewayHandle {
  const wss = new WebSocketServer({ noServer: true })

  // One live session per CLIENT connection (userId|conn), retained briefly across
  // reconnects (see GRACE_MS). Keyed by connection — not by data bucket — so two
  // clients sharing a `?user=` bucket (a second device, or two tabs) each get their
  // own game session instead of the newcomer hijacking the first's DR stream.
  const sessions = new Map<string, LiveSession>()

  httpServer.on('upgrade', (req, socket, head) => {
    // Only handle /ws upgrades; anything else (future routes) is left alone.
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname !== '/ws') return

    // Auth: a shared bearer token via ?token= (works from a PWA's WebSocket URL).
    // The SGE game login is still per-user on top of this; the token just gates
    // who may reach the server at all. Harden to per-user tokens before exposing
    // this to strangers — see README "Known limitations".
    if (token && url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Which user's data bucket this connection uses. TODAY this is a client-
    // supplied hint (?user=<account>); in production it should be derived from an
    // authenticated per-user token, not trusted from the client. Falls back to a
    // shared "default" bucket (single-user behaviour) when absent.
    const r = req as ConnReq
    const conn = url.searchParams.get('conn') || randomUUID()
    // Identity resolution (active when accounts are enabled):
    //   • Signed in (any tier) → the DATA bucket is the ACCOUNT (`acct-<id>`), so
    //     settings, Lich profiles/custom scripts and avatars are shared across every
    //     device the user signs in on. This is the free "sync my setups" benefit.
    //   • The live SESSION is ALWAYS keyed per-connection (`…|conn`), signed in or
    //     not, so a second device/tab NEVER steals the first's game stream (that was
    //     the hijack). PAID still sets keepAlive so its per-device session survives
    //     the app being backgrounded/closed. (True cross-device *watch* — several
    //     clients viewing ONE running session — needs multi-emit + a session picker;
    //     that's a separate build, not the account-only key that caused the steal.)
    const authToken = url.searchParams.get('auth') ?? ''
    const account = accounts && authToken ? accounts.accountForToken(authToken) : null
    if (account) {
      const acctUser = `acct-${account.id}`
      const paid = account.tier === 'paid'
      // WATCH mode (paid): attach to ANOTHER of this account's live sessions instead
      // of this device's own — but only if it actually exists, else fall back to own.
      // Attaching is non-destructive now (multi-emit broadcasts to every client), so
      // the watcher mirrors the stream rather than stealing it.
      const watchConn = url.searchParams.get('watch') ?? ''
      const useConn = (paid && watchConn && sessions.has(`${acctUser}|${watchConn}`)) ? watchConn : conn
      r.magiloomUser  = acctUser
      r.magiloomKey   = `${acctUser}|${useConn}`
      r.magiloomPaid  = paid
      r.magiloomWatch = useConn !== conn
    } else {
      const userId = url.searchParams.get('user') ?? 'default'
      r.magiloomUser  = userId
      r.magiloomKey   = `${userId}|${conn}`
      r.magiloomPaid  = false
      r.magiloomWatch = false
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket, req: ConnReq) => {
    const userId   = req.magiloomUser ?? 'default'
    const key      = req.magiloomKey ?? userId
    const paid     = req.magiloomPaid ?? false
    const watching = req.magiloomWatch ?? false
    const emit = (channel: string, ...args: unknown[]) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'event', channel, args }))
      }
    }

    // Attach to the session for this key (creating it if new). Multiple clients may
    // attach to one session (a device watching another) — events broadcast to all, so
    // a newcomer mirrors the stream instead of stealing it. Attaching cancels any
    // pending grace/keepalive dispose.
    let live = sessions.get(key)
    if (live) {
      if (live.grace) { clearTimeout(live.grace); live.grace = null }
      live.detachedAt = null
      live.keepAlive = live.keepAlive || paid   // a paid client attaching upgrades it
    } else {
      const userCtx = registry.get(userId)
      live = { session: new Session(userCtx, server), grace: null, detachedAt: null, keepAlive: paid, createdAt: Date.now() }
      sessions.set(key, live)
    }
    const session = live.session
    const removeClient = session.addClient(emit, watching)

    ws.on('message', async (raw) => {
      let msg: InvokeMsg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t !== 'invoke') return

      // Cross-session query, answered by the gateway (it owns the sessions map): list
      // this account's live sessions so a paid client can pick one to watch.
      if (msg.channel === 'session:list') {
        const prefix = userId + '|'
        const result: Array<{ conn: string; charName: string; connected: boolean; current: boolean }> = []
        for (const [k, lv] of sessions) {
          if (!k.startsWith(prefix)) continue
          result.push({
            conn: k.slice(prefix.length),
            charName: lv.session.getCharName(),
            connected: lv.session.isGameConnected(),
            current: k === key,
          })
        }
        ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, result }))
        return
      }

      try {
        const result = await session.invoke(msg.channel, msg.args ?? [])
        ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, result }))
      } catch (err) {
        ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: String(err) }))
      }
    })

    // On disconnect, detach THIS client. The session lives on while other clients are
    // still attached (watchers). Once the LAST client leaves, hold it briefly so a
    // quick reconnect resumes; PAID sessions are held for the long KEEPALIVE window
    // while DR is up (backgrounded/closed app stays online, push keeps firing). FREE +
    // anonymous get only the short GRACE, so their connection drops once gone (paywall).
    const onGone = () => {
      removeClient()
      const cur = sessions.get(key)
      if (!cur || cur.session !== session || cur.grace) return
      if (session.hasClients()) return   // other viewers still attached — keep it live
      cur.detachedAt = Date.now()
      const check = () => {
        cur.grace = null
        if (sessions.get(key) !== cur || cur.detachedAt === null) return  // reattached
        const abandoned = Date.now() - cur.detachedAt
        if (cur.keepAlive && session.isGameConnected() && abandoned < KEEPALIVE_MS) {
          cur.grace = setTimeout(check, KEEPALIVE_POLL_MS)  // paid + live — keep holding
          return
        }
        sessions.delete(key)
        session.dispose()
      }
      cur.grace = setTimeout(check, cur.keepAlive && session.isGameConnected() ? KEEPALIVE_POLL_MS : GRACE_MS)
    }
    ws.on('close', onGone)
    ws.on('error', onGone)
  })

  // Live snapshot of the sessions map for the metrics endpoints (see index.ts).
  return {
    snapshot(): GatewaySnapshot {
      const stats: SessionStat[] = []
      const onlineNames = new Set<string>()
      let connections = 0, playing = 0
      for (const lv of sessions.values()) {
        const s = lv.session
        const gameConnected = s.isGameConnected()
        const clients = s.clientCount()
        connections += clients
        if (gameConnected) {
          playing++
          const name = s.getCharName()
          if (name) onlineNames.add(name.toLowerCase())
        }
        stats.push({
          charName:      s.getCharName(),
          gameConnected,
          clients,
          paid:          lv.keepAlive,
          detached:      lv.detachedAt !== null,
          connectedAt:   lv.createdAt,
        })
      }
      return {
        online:        onlineNames.size,
        playing,
        connections,
        totalSessions: sessions.size,
        sessions:      stats,
      }
    },
  }
}
