import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolveGitHubAuth, dispatchWorkflow, type GitHubAuth } from './lib/github-app'

// ── Lootify daily trigger ───────────────────────────────────────────────────────
// The lootify repo claims DragonRealms daily login rewards, and wants to run at
// 03:00 America/Chicago. GitHub's own `schedule:` cannot do that: scheduled runs go
// on a shared best-effort queue that GitHub deprioritises under load, and delays of
// several hours are normal and documented. A workflow can absorb an EARLY trigger by
// sleeping, which is what lootify used to do — but nothing inside a workflow can fix
// a LATE one: the same job at 06:00 kept landing at 10:00, and moving the cron
// earlier moves the queue delay with it rather than escaping it.
//
// A workflow_dispatch through the REST API is not queued that way; it starts within
// seconds. This server is already awake with its own clock, so it makes that call at
// 03:00 Central and lootify's cron becomes a backstop rather than the mechanism.
//
// Failure modes this has to survive, since a missed morning is a missed reward:
//   • a redeploy at 02:58 — the fired-today marker is on the volume, and boot does a
//     catch-up dispatch if the target has already passed today (within a window).
//   • the clock jumping, or a long timer firing late — the wait is chunked into
//     minutes and re-checked against the wall clock rather than trusted once.
//   • GitHub being briefly down — the dispatch retries with backoff.
//   • THIS SERVER being down across 03:00 — nothing here can help, which is why
//     lootify keeps one late cron that no-ops if a run already succeeded today.

const STATE_FILE = 'lootify-cron.json'
/** Re-check the clock at least this often while waiting, so a suspended container or
 *  a stepped clock cannot turn one long sleep into a missed morning. */
const MAX_SLEEP_MS = 60_000
const RETRY_DELAYS_MS = [30_000, 120_000]

interface CronState {
  /** Local (target-timezone) date we last dispatched for, 'YYYY-MM-DD'. The dedupe
   *  key for catch-up: one dispatch per local day, whoever gets there first. */
  lastFiredDay: string | null
  lastFiredAt: number | null
  lastResult: 'ok' | 'error' | null
  lastError: string | null
}

export interface LootifyStatus extends CronState {
  /** The operator asked for this feature (MAGILOOM_LOOTIFY_ENABLED=1). */
  enabled: boolean
  /** ...and it actually started. These differ when the credential is missing or
   *  malformed, which is precisely the state the dashboard has to be able to show:
   *  a card that hides itself when misconfigured teaches you nothing until the
   *  morning it doesn't run. */
  armed: boolean
  auth: 'app' | 'pat' | null
  repo: string
  workflow: string
  ref: string
  at: string
  tz: string
  nextRun: number | null
  /** Expiry of the current installation token — App auth only, and the point of it:
   *  a value here that keeps moving forward is the rotation working. */
  tokenExpiresAt: number | null
}

const ENABLED  = process.env['MAGILOOM_LOOTIFY_ENABLED'] === '1'
const REPO     = process.env['MAGILOOM_LOOTIFY_REPO']     ?? 'jackfperryjr/lootify'
const WORKFLOW = process.env['MAGILOOM_LOOTIFY_WORKFLOW'] ?? 'lootify.yaml'
const REF      = process.env['MAGILOOM_LOOTIFY_REF']      ?? 'main'
const AT       = process.env['MAGILOOM_LOOTIFY_AT']       ?? '03:00'
const TZ       = process.env['MAGILOOM_LOOTIFY_TZ']       ?? 'America/Chicago'
/** How late a catch-up dispatch is still worth making. Past this, the day's run is
 *  lootify's backstop cron's problem — firing at 23:00 for a 03:00 job is worse than
 *  not firing, because it moves the reward claim to the wrong side of the day. */
const CATCHUP_MS = Number(process.env['MAGILOOM_LOOTIFY_CATCHUP_HOURS'] ?? 6) * 3600_000

import { dayKey, nextAfter, targetOn } from './lib/zoned-clock'
export { dayKey, nextAfter }

// ── Scheduler ───────────────────────────────────────────────────────────────────

let auth: GitHubAuth | null = null
let statePath = ''
let state: CronState = { lastFiredDay: null, lastFiredAt: null, lastResult: null, lastError: null }
let nextRun: number | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let started = false

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[lootify] ${msg}`)
}

function loadState(): void {
  if (!existsSync(statePath)) return
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) as Partial<CronState> }
  } catch { /* a corrupt marker just means we might dispatch twice; not worth failing over */ }
}

function saveState(): void {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2))
  } catch (err) {
    log(`could not persist state: ${String(err)}`)
  }
}

function parseAt(): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(AT.trim())
  const hh = m ? Number(m[1]) : 6
  const mm = m ? Number(m[2]) : 0
  if (!m || hh > 23 || mm > 59) {
    log(`MAGILOOM_LOOTIFY_AT="${AT}" is not HH:MM — falling back to 03:00`)
    return { hh: 6, mm: 0 }
  }
  return { hh, mm }
}

async function fire(reason: string, attempt = 0): Promise<void> {
  if (!auth) return
  const day = dayKey(Date.now(), TZ)
  try {
    await dispatchWorkflow(auth, REPO, WORKFLOW, REF)
    state = { lastFiredDay: day, lastFiredAt: Date.now(), lastResult: 'ok', lastError: null }
    saveState()
    log(`dispatched ${REPO}/${WORKFLOW} (${reason})`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Record the failure before deciding to retry, so /admin shows the problem
    // during the retry window rather than only after it.
    state = { ...state, lastResult: 'error', lastError: message, lastFiredAt: Date.now() }
    saveState()
    const delay = RETRY_DELAYS_MS[attempt]
    if (delay != null) {
      log(`dispatch failed (${message}) — retrying in ${Math.round(delay / 1000)}s`)
      retryTimer = setTimeout(() => { void fire(reason, attempt + 1) }, delay)
      retryTimer.unref()
    } else {
      log(`dispatch failed permanently: ${message}`)
    }
  }
}

function arm(): void {
  if (nextRun == null) return
  const delay = Math.max(0, nextRun - Date.now())
  timer = setTimeout(tick, Math.min(delay, MAX_SLEEP_MS))
  timer.unref()
}

function tick(): void {
  if (nextRun != null && Date.now() >= nextRun) {
    const { hh, mm } = parseAt()
    void fire('scheduled')
    nextRun = nextAfter(Date.now(), TZ, hh, mm)
  }
  arm()
}

/**
 * Start the daily dispatch. A no-op unless MAGILOOM_LOOTIFY_ENABLED=1 and a GitHub
 * credential is configured, so the feature is genuinely off by default.
 */
export function startLootifyCron(dataDir: string): void {
  if (started || !ENABLED) return
  auth = resolveGitHubAuth(REPO)
  if (!auth) {
    const why = 'enabled but no GitHub credential — set MAGILOOM_GITHUB_APP_ID + MAGILOOM_GITHUB_APP_KEY (preferred) or MAGILOOM_GITHUB_TOKEN'
    state = { ...state, lastResult: 'error', lastError: why }
    log(why)
    return
  }
  started = true
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  statePath = join(dataDir, STATE_FILE)
  loadState()

  const { hh, mm } = parseAt()
  const now = Date.now()
  const todayTarget = targetOn(now, TZ, hh, mm)
  // Catch-up: a deploy landing just after the target would otherwise skip the day
  // entirely, and a redeploy at 02:58 is exactly when one is most likely.
  if (dayKey(now, TZ) !== state.lastFiredDay && now >= todayTarget && now - todayTarget <= CATCHUP_MS) {
    log(`missed today's ${AT} ${TZ} target by ${Math.round((now - todayTarget) / 60_000)}m — dispatching now`)
    void fire('catch-up')
  }
  nextRun = nextAfter(now, TZ, hh, mm)
  log(`armed via ${auth.kind} auth — next dispatch ${new Date(nextRun).toISOString()} (${AT} ${TZ})`)
  arm()
}

export function stopLootifyCron(): void {
  if (timer) clearTimeout(timer)
  if (retryTimer) clearTimeout(retryTimer)
  timer = retryTimer = null
  started = false
}

/** Dispatch right now, ignoring the schedule — the admin dashboard's "Run now", and
 *  the way to prove a freshly configured credential works without waiting for 03:00. */
export async function triggerLootifyNow(): Promise<{ ok: boolean; error?: string }> {
  if (!auth) return { ok: false, error: 'Lootify trigger is not configured on this server.' }
  try {
    await dispatchWorkflow(auth, REPO, WORKFLOW, REF)
    state = { lastFiredDay: dayKey(Date.now(), TZ), lastFiredAt: Date.now(), lastResult: 'ok', lastError: null }
    saveState()
    log(`dispatched ${REPO}/${WORKFLOW} (manual)`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    state = { ...state, lastResult: 'error', lastError: message, lastFiredAt: Date.now() }
    saveState()
    return { ok: false, error: message }
  }
}

export function lootifyStatus(): LootifyStatus {
  return {
    ...state,
    enabled: ENABLED,
    armed: started,
    auth: auth?.kind ?? null,
    repo: REPO, workflow: WORKFLOW, ref: REF, at: AT, tz: TZ,
    nextRun,
    tokenExpiresAt: auth?.currentExpiry() ?? null,
  }
}
