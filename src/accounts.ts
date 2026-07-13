import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

// ── Magiloom accounts (dormant infrastructure) ──────────────────────────────────
// Real per-user accounts, distinct from the Simutronics game account and from the
// per-device `?user=` bucket. This is the identity layer a PAID "watch mode" needs:
// a stable id that ties a persistent server-side DR session (and its push
// subscriptions) to a person, so any of their devices can attach to and watch the
// same running connection.
//
// Nothing here is exposed yet — the /auth endpoints and the gateway's account path
// are both gated behind MAGILOOM_ACCOUNTS_ENABLED (off by default). It's built and
// ready; wiring it into the client + a paywall is a later, deliberate step.
//
// Storage is plain JSON (one file, no Postgres — same call as the rest of the
// server), fine for the expected scale. Passwords are scrypt-hashed; auth tokens
// are opaque random strings persisted so they survive restarts and stay revocable.

export type AccountTier = 'free' | 'paid'

export interface Account {
  id:           string
  email:        string   // normalized (trimmed, lowercased) — also the unique key
  passwordHash: string   // "saltHex:hashHex" (scrypt)
  tier:         AccountTier
  createdAt:    number
}

/** Account shape safe to return over the wire (no hash). */
export interface PublicAccount { id: string; email: string; tier: AccountTier }

export interface RegisterResult { ok: true; account: PublicAccount; token: string }
export interface AuthError      { ok: false; error: string }

interface Persisted {
  accounts:    Record<string, Account>   // id    → account
  emailIndex:  Record<string, string>    // email → id
  tokens:      Record<string, string>    // token → id
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export class AccountStore {
  private data: Persisted = { accounts: {}, emailIndex: {}, tokens: {} }
  private readonly file: string
  // Emails that are treated as 'paid' regardless of stored tier — a test/allowlist
  // override (MAGILOOM_PRO_EMAILS) so we can grant pro without a billing flow yet.
  private readonly proEmails: Set<string>

  constructor(dataDir: string, proEmails: string[] = []) {
    this.file = join(dataDir, 'accounts.json')
    this.proEmails = new Set(proEmails.map(e => e.trim().toLowerCase()).filter(Boolean))
    this.load()
  }

  // ── Persistence ──────────────────────────────────────────────────────────────
  private load(): void {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>
        this.data = {
          accounts:   parsed.accounts   ?? {},
          emailIndex: parsed.emailIndex ?? {},
          tokens:     parsed.tokens     ?? {},
        }
      }
    } catch { /* start empty on a corrupt/absent file */ }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(tmp, this.file)   // atomic-ish: never leaves a half-written accounts.json
  }

  // ── Password hashing (scrypt) ────────────────────────────────────────────────
  private hashPassword(password: string): string {
    const salt = randomBytes(16)
    const hash = scryptSync(password, salt, 64)
    return `${salt.toString('hex')}:${hash.toString('hex')}`
  }

  private verifyPassword(password: string, stored: string): boolean {
    const [saltHex, hashHex] = stored.split(':')
    if (!saltHex || !hashHex) return false
    const expected = Buffer.from(hashHex, 'hex')
    const actual   = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  /** Effective tier: stored 'paid', or an allowlisted email, wins. */
  private effectiveTier(a: Account): AccountTier {
    return a.tier === 'paid' || this.proEmails.has(a.email) ? 'paid' : 'free'
  }

  private toPublic(a: Account): PublicAccount {
    return { id: a.id, email: a.email, tier: this.effectiveTier(a) }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  /** Create an account and issue its first token, or return a reason it failed. */
  register(email: string, password: string): RegisterResult | AuthError {
    const norm = email.trim().toLowerCase()
    if (!EMAIL_RE.test(norm))     return { ok: false, error: 'Enter a valid email address.' }
    if (password.length < 8)      return { ok: false, error: 'Password must be at least 8 characters.' }
    if (this.data.emailIndex[norm]) return { ok: false, error: 'An account with that email already exists.' }

    const account: Account = {
      id:           randomBytes(9).toString('hex'),
      email:        norm,
      passwordHash: this.hashPassword(password),
      tier:         'free',
      createdAt:    Date.now(),
    }
    this.data.accounts[account.id] = account
    this.data.emailIndex[norm] = account.id
    const token = this.mintToken(account.id)
    this.save()
    return { ok: true, account: this.toPublic(account), token }
  }

  /** Verify credentials and issue a fresh token, or return null on any mismatch. */
  login(email: string, password: string): RegisterResult | null {
    const id = this.data.emailIndex[email.trim().toLowerCase()]
    const account = id ? this.data.accounts[id] : undefined
    if (!account) return null
    if (!this.verifyPassword(password, account.passwordHash)) return null
    const token = this.mintToken(account.id)
    this.save()
    return { ok: true, account: this.toPublic(account), token }
  }

  private mintToken(accountId: string): string {
    const token = randomBytes(32).toString('hex')
    this.data.tokens[token] = accountId
    return token
  }

  /** Resolve an auth token to its account id (or null). Does not touch disk. */
  resolveToken(token: string): string | null {
    return (token && this.data.tokens[token]) || null
  }

  /** Resolve an auth token straight to its public account. */
  accountForToken(token: string): PublicAccount | null {
    const id = this.resolveToken(token)
    const a = id ? this.data.accounts[id] : undefined
    return a ? this.toPublic(a) : null
  }

  revokeToken(token: string): void {
    if (this.data.tokens[token]) { delete this.data.tokens[token]; this.save() }
  }

  getAccount(id: string): PublicAccount | null {
    const a = this.data.accounts[id]
    return a ? this.toPublic(a) : null
  }

  /** Set an account's plan — the hook a billing webhook flips to grant watch mode. */
  setTier(id: string, tier: AccountTier): boolean {
    const a = this.data.accounts[id]
    if (!a) return false
    a.tier = tier
    this.save()
    return true
  }
}
