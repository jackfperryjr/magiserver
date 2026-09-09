import { createSign } from 'crypto'

// ── GitHub credentials for server-initiated API calls ───────────────────────────
// magiserver dispatches workflows in other repos (see lootify-cron.ts), which needs
// a credential that outlives a deploy. Two are supported, and the difference is
// entirely about rotation:
//
//   • GitHub App (preferred) — we hold the App's PRIVATE KEY, which never expires,
//     and mint a fresh INSTALLATION TOKEN good for one hour before each call. The
//     credential on the wire is therefore rotated automatically, hourly, forever,
//     with nothing to diarise. Set MAGILOOM_GITHUB_APP_ID + MAGILOOM_GITHUB_APP_KEY.
//
//   • Fine-grained PAT (fallback) — one long-lived string in the environment. GitHub
//     has no API to renew or re-mint a PAT, so this one CANNOT self-rotate: it dies
//     on its expiry date and the dispatch silently stops until a human replaces it.
//     Set MAGILOOM_GITHUB_TOKEN. Useful to get running in two minutes; move to the
//     App when you can.
//
// Nothing here activates unless one of those is configured — no credential, no
// feature, exactly like push/accounts/admin elsewhere in this server.

const API = 'https://api.github.com'

/** Re-mint an installation token this long before it actually expires, so a call
 *  can never start with a token that dies mid-flight. */
const RENEW_MARGIN_MS = 5 * 60 * 1000

export interface GitHubAuth {
  /** 'app' self-rotates hourly; 'pat' is a fixed string with a human expiry date. */
  readonly kind: 'app' | 'pat'
  /** A bearer token valid for the next few minutes, minting a new one if needed. */
  token(): Promise<string>
  /** Expiry of the CURRENT installation token (app only; null for a PAT, whose
   *  expiry GitHub does not expose to the bearer). For the admin dashboard. */
  currentExpiry(): number | null
}

function b64url(v: string | Buffer): string {
  return Buffer.from(v).toString('base64url')
}

/** The App's private key, signed as a short-lived JWT. This authenticates us AS THE
 *  APP — the only thing it can do is ask for installation tokens. GitHub caps the
 *  lifetime at 10 minutes; 9 leaves room for clock skew on their side.
 *
 *  Exported for test-lootify-cron.ts: a wrong signature here is a 401 that looks
 *  exactly like a wrong key, and the difference is worth being able to tell apart. */
export function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  // iat is backdated a minute because GitHub rejects a JWT issued in ITS future,
  // and a container clock running slightly fast is otherwise a 401 we'd never
  // reproduce locally.
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  signer.end()
  return `${header}.${payload}.${signer.sign(pem).toString('base64url')}`
}

/** Railway env vars can hold a multi-line PEM, but pasting one is error-prone, so a
 *  base64 blob of the same file is accepted too — whichever survived the clipboard. */
function normalizeKey(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.includes('BEGIN')) return trimmed.replace(/\n/g, '\n')
  return Buffer.from(trimmed, 'base64').toString('utf8')
}

async function ghJson(path: string, bearer: string, method: 'GET' | 'POST'): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${bearer}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'magiloom-server',
    },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status} ${body.slice(0, 200)}`)
  return body ? JSON.parse(body) : null
}

class AppAuth implements GitHubAuth {
  readonly kind = 'app' as const
  private installationId: number | null
  private cached: { token: string; expiresAt: number } | null = null
  /** Concurrent callers share one mint rather than racing for two tokens. */
  private inflight: Promise<string> | null = null

  constructor(private appId: string, private pem: string, private repo: string, installationId: number | null) {
    this.installationId = installationId
  }

  currentExpiry(): number | null { return this.cached?.expiresAt ?? null }

  async token(): Promise<string> {
    const now = Date.now()
    if (this.cached && this.cached.expiresAt - RENEW_MARGIN_MS > now) return this.cached.token
    if (this.inflight) return this.inflight
    this.inflight = this.mint().finally(() => { this.inflight = null })
    return this.inflight
  }

  private async mint(): Promise<string> {
    const jwt = appJwt(this.appId, this.pem)
    // The installation id is derivable from the repo the App is installed on, so the
    // operator sets two env vars instead of three — and pasting the wrong id is one
    // fewer way to get an inscrutable 404.
    if (this.installationId == null) {
      const inst = await ghJson(`/repos/${this.repo}/installation`, jwt, 'GET') as { id?: number }
      if (typeof inst?.id !== 'number') throw new Error(`no App installation found on ${this.repo}`)
      this.installationId = inst.id
    }
    const res = await ghJson(`/app/installations/${this.installationId}/access_tokens`, jwt, 'POST') as
      { token?: string; expires_at?: string }
    if (!res?.token) throw new Error('installation token response had no token')
    this.cached = {
      token: res.token,
      expiresAt: res.expires_at ? Date.parse(res.expires_at) : Date.now() + 60 * 60 * 1000,
    }
    return this.cached.token
  }
}

class PatAuth implements GitHubAuth {
  readonly kind = 'pat' as const
  constructor(private pat: string) {}
  currentExpiry(): null { return null }
  async token(): Promise<string> { return this.pat }
}

/**
 * Whichever credential is configured, App first. Returns null when neither is —
 * the caller treats that as "feature off" rather than an error.
 */
export function resolveGitHubAuth(repo: string): GitHubAuth | null {
  const appId = process.env['MAGILOOM_GITHUB_APP_ID']?.trim()
  const rawKey = process.env['MAGILOOM_GITHUB_APP_KEY']
  if (appId && rawKey) {
    const installEnv = Number(process.env['MAGILOOM_GITHUB_APP_INSTALLATION'] ?? '')
    return new AppAuth(appId, normalizeKey(rawKey), repo, Number.isFinite(installEnv) && installEnv > 0 ? installEnv : null)
  }
  const pat = process.env['MAGILOOM_GITHUB_TOKEN']?.trim()
  return pat ? new PatAuth(pat) : null
}

/** POST a workflow_dispatch. Resolves on GitHub's 204; throws with the API's own
 *  message otherwise, because the useful ones (404 = App not installed / no Actions
 *  permission, 422 = workflow lacks a workflow_dispatch trigger) are worth logging
 *  verbatim rather than as "dispatch failed". */
export async function dispatchWorkflow(
  auth: GitHubAuth, repo: string, workflow: string, ref: string,
): Promise<void> {
  const res = await fetch(`${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${await auth.token()}`,
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'magiloom-server',
    },
    body: JSON.stringify({ ref }),
  })
  if (res.status === 204) return
  throw new Error(`dispatch ${repo}/${workflow} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
}
