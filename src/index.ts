import { createServer } from 'http'
import { MapStore } from './lib/map-store'
import { UserRegistry } from './user-context'
import { PortAllocator } from './port-allocator'
import { attachGateway } from './gateway'
import type { ServerContext } from './session'
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
const server: ServerContext = { map, ports, dataDir: DATA_DIR }

initPush(DATA_DIR)

// ── HTTP: health + push endpoints ────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '', 'http://localhost')
  const cors = {
    'Access-Control-Allow-Origin': process.env['MAGILOOM_ALLOW_ORIGIN'] ?? '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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

attachGateway(httpServer, users, server)

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
