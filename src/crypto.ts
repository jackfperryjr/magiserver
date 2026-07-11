import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

// ── Password-at-rest encryption ────────────────────────────────────────────────
// On the desktop app, account passwords are encrypted with Electron's safeStorage
// (OS keychain / DPAPI). There is no OS keychain on a headless server, so we
// derive a key from a server-side secret and use AES-256-GCM instead.
//
// Set MAGILOOM_SECRET to a long random string in the deploy environment
// (Railway → Variables). If it is missing we fall back to a random per-boot key,
// which means saved passwords won't decrypt after a restart — fine for dev, but
// you MUST set MAGILOOM_SECRET in production so "remember password" survives
// redeploys.

const secret = process.env['MAGILOOM_SECRET']
if (!secret) {
  // eslint-disable-next-line no-console
  console.warn(
    '[crypto] MAGILOOM_SECRET is not set — using an ephemeral key. Saved passwords ' +
    'will not survive a restart. Set MAGILOOM_SECRET in production.'
  )
}

// scrypt derives a stable 32-byte key from the secret. A fixed salt is acceptable
// here because the secret itself is the security boundary (a single-tenant server
// key), not a user password in a shared table.
const key = scryptSync(secret ?? randomBytes(32).toString('hex'), 'magiloom-pw', 32)

/** Encrypt a plaintext password → base64(iv | tag | ciphertext). */
export function encryptString(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

/** Decrypt base64(iv | tag | ciphertext) → plaintext, or null if it can't. */
export function decryptString(b64: string): string | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const ct = buf.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function isEncryptionAvailable(): boolean {
  return true
}
