import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import webpush, { type PushSubscription } from 'web-push'

// ── Web Push (PWA notifications) ────────────────────────────────────────────────
// This delivers notifications to the PWA even when it is backgrounded or closed —
// the phone equivalent of the desktop app's toast/desktop notifications. The
// server evaluates alert rules (see trigger-engine.ts) and calls notify() here.
//
// Subscriptions are keyed by userId so a match for one user only pings THAT user's
// devices, never everyone's.
//
// Setup:
//   1. Generate VAPID keys once:  npm run vapid
//   2. Set MAGILOOM_VAPID_PUBLIC / MAGILOOM_VAPID_PRIVATE in the environment.
//   3. The PWA fetches GET /push/vapid, subscribes, and POSTs { userId, subscription }
//      to /push/subscribe.

interface StoredSub { userId: string; sub: PushSubscription }

let ready = false
let subsPath = ''
// Keyed by the subscription endpoint (unique per device/browser).
const subs = new Map<string, StoredSub>()

export function initPush(dataDir: string): void {
  const pub = process.env['MAGILOOM_VAPID_PUBLIC']
  const priv = process.env['MAGILOOM_VAPID_PRIVATE']
  const subject = process.env['MAGILOOM_VAPID_SUBJECT'] ?? 'mailto:admin@magiloom.local'
  if (!pub || !priv) {
    // eslint-disable-next-line no-console
    console.warn('[push] VAPID keys not set — push notifications disabled. Run `npm run vapid`.')
    return
  }
  webpush.setVapidDetails(subject, pub, priv)

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  subsPath = join(dataDir, 'push-subscriptions.json')
  if (existsSync(subsPath)) {
    try {
      const arr = JSON.parse(readFileSync(subsPath, 'utf8')) as StoredSub[]
      for (const s of arr) if (s?.sub?.endpoint) subs.set(s.sub.endpoint, s)
    } catch { /* ignore corrupt file */ }
  }
  ready = true
}

export function isPushReady(): boolean { return ready }

export function vapidPublicKey(): string {
  return process.env['MAGILOOM_VAPID_PUBLIC'] ?? ''
}

export function addSubscription(userId: string, sub: PushSubscription): void {
  if (!sub?.endpoint) return
  subs.set(sub.endpoint, { userId: userId || 'default', sub })
  persist()
}

export function removeSubscription(endpoint: string): void {
  if (subs.delete(endpoint)) persist()
}

/**
 * Push a notification. With a userId, only that user's devices are pinged; without
 * one, all devices (server-wide broadcast). Prunes dead subscriptions.
 */
export async function notify(
  payload: { title: string; body: string; tag?: string },
  userId?: string,
): Promise<void> {
  if (!ready) return
  const data = JSON.stringify(payload)
  const targets = [...subs.values()].filter(s => !userId || s.userId === userId)
  await Promise.all(targets.map(async ({ sub }) => {
    try {
      await webpush.sendNotification(sub, data)
    } catch (err) {
      // 404/410 mean the subscription is gone — drop it.
      const code = (err as { statusCode?: number }).statusCode
      if (code === 404 || code === 410) removeSubscription(sub.endpoint)
    }
  }))
}

function persist(): void {
  if (!subsPath) return
  try {
    writeFileSync(subsPath, JSON.stringify([...subs.values()], null, 2), 'utf8')
  } catch { /* best-effort */ }
}
