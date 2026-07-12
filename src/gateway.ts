import type { Server as HttpServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { Session, type ServerContext } from './session'
import type { UserRegistry } from './user-context'

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

interface LiveSession { session: Session; grace: ReturnType<typeof setTimeout> | null }

/** Attach the game WebSocket gateway at /ws on an existing HTTP server. */
export function attachGateway(
  httpServer: HttpServer,
  registry: UserRegistry,
  server: ServerContext,
): void {
  const wss = new WebSocketServer({ noServer: true })

  // One live session per user, retained briefly across reconnects (see GRACE_MS).
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
    const userId = url.searchParams.get('user') ?? 'default'
    ;(req as { magiloomUser?: string }).magiloomUser = userId

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket, req: { magiloomUser?: string }) => {
    const userId = req.magiloomUser ?? 'default'
    const emit = (channel: string, ...args: unknown[]) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'event', channel, args }))
      }
    }

    // Re-attach to a session kept alive during its grace window (resumes the same
    // DR connection), else start a fresh one for this user.
    let live = sessions.get(userId)
    if (live) {
      if (live.grace) { clearTimeout(live.grace); live.grace = null }
      live.session.setEmit(emit)
    } else {
      const userCtx = registry.get(userId)
      live = { session: new Session(userCtx, server, emit), grace: null }
      sessions.set(userId, live)
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

    // On disconnect, DON'T tear the session down immediately — hold it (and its DR
    // connection) for the grace window so a reconnect resumes. Only dispose if no
    // reconnect arrives, and only if this exact session is still the current one.
    const onGone = () => {
      const cur = sessions.get(userId)
      if (!cur || cur.session !== session || cur.grace) return
      cur.grace = setTimeout(() => {
        if (sessions.get(userId) === cur) sessions.delete(userId)
        session.dispose()
      }, GRACE_MS)
    }
    ws.on('close', onGone)
    ws.on('error', onGone)
  })
}
