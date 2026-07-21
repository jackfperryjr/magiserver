import { createServer } from 'http'
import { MapStore } from './lib/map-store'
import { UserRegistry } from './user-context'
import { timingSafeEqual } from 'crypto'
import { PortAllocator } from './port-allocator'
import { MessageHub } from './message-hub'
import { attachGateway, type GatewayHandle } from './gateway'
import { ADMIN_HTML } from './admin-page'
import type { ServerContext } from './session'
import { AccountStore } from './accounts'
import {
  initPush, isPushReady, vapidPublicKey, addSubscription, removeSubscription,
} from './push'

// ── Headless Magiloom server ────────────────────────────────────────────────────
// The desktop app's src/main/index.ts, minus Electron. It hosts the game
// connection + Lich + script engine per client over a WebSocket, so a PWA (or the
// desktop app in "remote" mode) can drive DragonRealms without a local install.

const PORT = Number(process.env['PORT'] ?? 8787)   // Railway sets PORT for you
const DATA_DIR = process.env['MAGILOOM_DATA_DIR'] ?? `${process.cwd()}/data`

// Per-user isolation: each user gets their own settings/broadcast/log under
// DATA_DIR/users/<id>/ (see user-context.ts). The world map is a single shared DB,
// and Lich ports come from a server-wide pool.
const users = new UserRegistry(DATA_DIR)
const map   = new MapStore(DATA_DIR)
const ports = new PortAllocator()
// Server-global messaging: in-memory presence + per-character JSON threads/contacts.
// Identity is the authenticated character name (see message-hub.ts / message-store.ts).
const hub   = new MessageHub(DATA_DIR)
const server: ServerContext = { map, ports, hub, dataDir: DATA_DIR }

// Accounts (paid "watch mode" identity) are built but DORMANT: the /auth endpoints
// and the gateway's account-keyed sessions only activate with this flag on. Off by
// default, so nothing here is exposed until we deliberately ship + gate the feature.
const ACCOUNTS_ENABLED = process.env['MAGILOOM_ACCOUNTS_ENABLED'] === '1'
// Admin metrics dashboard (/admin + /admin/stats). Gated two ways, both off by
// default so the whole surface 404s until one is configured:
//   • MAGILOOM_ADMIN_EMAILS — the preferred gate: sign in with a Magiloom account
//     whose email is allowlisted (claim-on-first-login sets the password). Uses the
//     AccountStore directly, independent of the public MAGILOOM_ACCOUNTS_ENABLED flag.
//   • MAGILOOM_ADMIN_TOKEN — an optional shared-secret break-glass, still accepted.
// The public /stats aggregate (counts only, no names) is always on regardless.
const ADMIN_TOKEN = process.env['MAGILOOM_ADMIN_TOKEN'] ?? ''
const ADMIN_EMAILS = (process.env['MAGILOOM_ADMIN_EMAILS'] ?? '').split(',')
const ADMIN_ENABLED = !!ADMIN_TOKEN || ADMIN_EMAILS.some(e => e.trim())
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
// Assigned once the gateway is attached (below); the request handler closes over it.
let gateway: GatewayHandle | null = null
// Allowlist of emails granted the paid tier without billing — for testing pro
// features. e.g. MAGILOOM_PRO_EMAILS="me@example.com,teammate@example.com".
const PRO_EMAILS = (process.env['MAGILOOM_PRO_EMAILS'] ?? '').split(',')
const accounts = new AccountStore(DATA_DIR, PRO_EMAILS, ADMIN_EMAILS)

initPush(DATA_DIR)

// ── HTTP: health + push endpoints ────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://localhost')
  const cors = {
    'Access-Control-Allow-Origin': process.env['MAGILOOM_ALLOW_ORIGIN'] ?? '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
    res.end(JSON.stringify({ ok: true, push: isPushReady(), lichPortsInUse: ports.inUse }))
    return
  }

  if (url.pathname === '/push/vapid' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
    res.end(JSON.stringify({ publicKey: vapidPublicKey() }))
    return
  }

  // Body: { userId, subscription }. userId scopes the push to that user's devices.
  if (url.pathname === '/push/subscribe' && req.method === 'POST') {
    readJson(req).then((body) => {
      const { userId, subscription } = body as { userId?: string; subscription: never }
      addSubscription(userId ?? 'default', subscription)
      res.writeHead(201, cors); res.end()
    }).catch(() => { res.writeHead(400, cors); res.end() })
    return
  }

  if (url.pathname === '/push/unsubscribe' && req.method === 'POST') {
    readJson(req).then((body) => {
      removeSubscription((body as { endpoint: string }).endpoint)
      res.writeHead(200, cors); res.end()
    }).catch(() => { res.writeHead(400, cors); res.end() })
    return
  }

  // ── Public live stats — aggregate counts only, NO character names ──────────────
  // Drives the "N adventurers online" indicator on the magiloom.com landing page.
  // Safe to expose: it reveals nothing about who is connected, only how many.
  if (url.pathname === '/stats' && req.method === 'GET') {
    const snap = gateway?.snapshot()
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
    res.end(JSON.stringify({
      ok: true,
      online:      snap?.online ?? 0,
      playing:     snap?.playing ?? 0,
      connections: snap?.connections ?? 0,
    }))
    return
  }

  // ── Admin metrics dashboard (off unless a gate is configured — see ADMIN_ENABLED) ─
  // /admin serves the viewer page; /admin/login authenticates a Magiloom account on
  // the admin allowlist; /admin/stats is the gated data feed (which DOES include
  // character names — for the operator's eyes only).
  if (url.pathname === '/admin' || url.pathname === '/admin/login' || url.pathname === '/admin/stats') {
    if (!ADMIN_ENABLED) { res.writeHead(404, cors); res.end(); return }
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(body))
    }
    // Is the caller authorized? Either the shared break-glass token, or an auth token
    // belonging to an admin-allowlisted account.
    const bearer = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '')
    const authorized = (): boolean => {
      const provided = url.searchParams.get('key') || bearer
      if (!provided) return false
      if (ADMIN_TOKEN && safeEq(provided, ADMIN_TOKEN)) return true
      const acct = accounts.accountForToken(provided)
      return !!acct && acct.admin
    }

    if (url.pathname === '/admin' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors })
      res.end(ADMIN_HTML)
      return
    }

    // Sign in with a Magiloom account. Only allowlisted emails may reach this, and an
    // allowlisted email with no account yet CLAIMS it here (first password wins), so
    // the operator never needs a separate registration step.
    if (url.pathname === '/admin/login' && req.method === 'POST') {
      readJson(req).then((b) => {
        const { email, password } = b as { email?: string; password?: string }
        const norm = (email ?? '').trim().toLowerCase()
        if (!accounts.isAdminEmail(norm)) { json(403, { ok: false, error: 'This email is not an authorized admin.' }); return }
        if (accounts.hasEmail(norm)) {
          const r = accounts.login(norm, password ?? '')
          if (r) json(200, { ok: true, token: r.token, account: r.account })
          else   json(401, { ok: false, error: 'Incorrect password.' })
        } else {
          const r = accounts.register(norm, password ?? '')   // claim on first login
          if (r.ok) json(201, { ok: true, token: r.token, account: r.account })
          else      json(400, r)                               // e.g. password too short
        }
      }).catch(() => json(400, { ok: false, error: 'Bad request.' }))
      return
    }

    if (url.pathname === '/admin/stats' && req.method === 'GET') {
      if (!authorized()) { json(401, { ok: false, error: 'Unauthorized' }); return }
      const snap = gateway?.snapshot()
        ?? { online: 0, playing: 0, connections: 0, totalSessions: 0, sessions: [] }
      json(200, {
        ok: true,
        now:            Date.now(),
        uptimeSec:      process.uptime(),
        lichPortsInUse: ports.inUse,
        push:           isPushReady(),
        ...snap,
      })
      return
    }
    res.writeHead(405, cors); res.end()
    return
  }

  // ── Accounts (dormant unless MAGILOOM_ACCOUNTS_ENABLED=1) ──────────────────────
  // Registered only when the flag is on, so the feature is genuinely unexposed by
  // default — the routes 404 like any unknown path until we turn accounts on.
  if (ACCOUNTS_ENABLED && url.pathname.startsWith('/auth/')) {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(body))
    }
    if (url.pathname === '/auth/register' && req.method === 'POST') {
      readJson(req).then((b) => {
        const { email, password } = b as { email?: string; password?: string }
        const r = accounts.register(email ?? '', password ?? '')
        json(r.ok ? 201 : 400, r)
      }).catch(() => json(400, { ok: false, error: 'Bad request.' }))
      return
    }
    if (url.pathname === '/auth/login' && req.method === 'POST') {
      readJson(req).then((b) => {
        const { email, password } = b as { email?: string; password?: string }
        const r = accounts.login(email ?? '', password ?? '')
        if (r) json(200, r); else json(401, { ok: false, error: 'Incorrect email or password.' })
      }).catch(() => json(400, { ok: false, error: 'Bad request.' }))
      return
    }
    if (url.pathname === '/auth/me' && req.method === 'GET') {
      const token = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '')
      const account = accounts.accountForToken(token)
      if (account) json(200, { ok: true, account }); else json(401, { ok: false, error: 'Not authenticated.' })
      return
    }
    json(404, { ok: false, error: 'Unknown auth route.' })
    return
  }

  res.writeHead(404, cors); res.end()
})

function readJson(req: import('http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

gateway = attachGateway(httpServer, users, server, ACCOUNTS_ENABLED ? accounts : null)

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[magiloom-server] listening on :${PORT}  (ws at /ws, data in ${DATA_DIR})`)
  if (!process.env['MAGILOOM_TOKEN']) {
    // eslint-disable-next-line no-console
    console.warn('[magiloom-server] MAGILOOM_TOKEN is not set — the /ws gateway is OPEN. Set it before exposing this server.')
  }
})

function shutdown(): void {
  users.dispose()
  map.dispose()
  httpServer.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
