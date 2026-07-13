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
}

/** Extra fields we stash on the upgrade request to carry into the connection. */
interface ConnReq { magiloomUser?: string; magiloomKey?: string; magiloomPaid?: boolean }

/** Attach the game WebSocket gateway at /ws on an existing HTTP server.
 *  `accounts` is passed only when MAGILOOM_ACCOUNTS_ENABLED — otherwise null and
 *  the account-identity path below is inert (device-keyed behaviour, unchanged). */
export function attachGateway(
  httpServer: HttpServer,
  registry: UserRegistry,
  server: ServerContext,
  accounts: AccountStore | null = null,
): void {
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
    //   • PAID → the live SESSION is keyed by the account ALONE (no conn), so any
    //     device attaches to the one running DR session (cross-device watch), and the
    //     gateway keeps it alive across client absence (see keepAlive below).
    //   • FREE / anonymous → per-device session keyed by conn; no watch, short grace.
    const authToken = url.searchParams.get('auth') ?? ''
    const account = accounts && authToken ? accounts.accountForToken(authToken) : null
    if (account) {
      const paid = account.tier === 'paid'
      const acctUser = `acct-${account.id}`
      r.magiloomUser = acctUser
      r.magiloomKey  = paid ? acctUser : `${acctUser}|${conn}`
      r.magiloomPaid = paid
    } else {
      const userId = url.searchParams.get('user') ?? 'default'
      r.magiloomUser = userId
      r.magiloomKey  = `${userId}|${conn}`
      r.magiloomPaid = false
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket, req: ConnReq) => {
    const userId = req.magiloomUser ?? 'default'
    const key    = req.magiloomKey ?? userId
    const paid   = req.magiloomPaid ?? false
    const emit = (channel: string, ...args: unknown[]) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'event', channel, args }))
      }
    }

    // Re-attach to THIS client's session kept alive during its grace window (resumes
    // the same DR connection), else start a fresh one. The key is per-connection, so
    // a different client on the same data bucket never re-attaches here.
    let live = sessions.get(key)
    if (live) {
      if (live.grace) { clearTimeout(live.grace); live.grace = null }
      live.detachedAt = null
      live.keepAlive = live.keepAlive || paid   // a paid client attaching upgrades it
      live.session.setEmit(emit)
    } else {
      const userCtx = registry.get(userId)
      live = { session: new Session(userCtx, server, emit), grace: null, detachedAt: null, keepAlive: paid }
      sessions.set(key, live)
    }
    const session = live.session
    session.replayInitialState()

    ws.on('message', async (raw) => {
      let msg: InvokeMsg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.t !== 'invoke') return

      try {
        const result = await session.invoke(msg.channel, msg.args ?? [])
        ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, result }))
      } catch (err) {
        ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: String(err) }))
      }
    })

    // On disconnect, hold the session briefly so a quick reconnect resumes. PAID
    // sessions are additionally held for the long KEEPALIVE window while DR is up —
    // that's the feature: a backgrounded/closed app keeps its character online, push
    // keeps firing, and any device resumes/watches it. FREE + anonymous get only the
    // short GRACE, so their connection drops once they're gone (paywall).
    const onGone = () => {
      const cur = sessions.get(key)
      if (!cur || cur.session !== session || cur.grace) return
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
}
