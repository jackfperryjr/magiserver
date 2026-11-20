import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolveGitHubAuth, dispatchWorkflow, githubRequest, type GitHubAuth } from './lib/github-app'
import { nextAfter, parseHHMM } from './lib/zoned-clock'

// ── Lich update schedule ────────────────────────────────────────────────────────
// Lich moves on this server by bumping the tag in the Dockerfile and redeploying
// (see the Dockerfile and lich-update-check.yml), and a redeploy restarts the
// server, dropping every connected game session. So the bump merges on a schedule
// the players are told about:
//
//   10:00 Central  this server dispatches lich-update-check.yml. On a new release it
//                  builds the image, smoke-starts Lich, and only then opens the PR.
//   every 5 min    this server looks for that open PR. The first time it sees one it
//                  fixes a merge time: the first 03:00 Central at least
//                  MIN_NOTICE hours away. That time goes on the /maintenance feed,
//                  which the web app turns into a countdown banner.
//   03:00 Central  this server dispatches merge-window.yml for exactly that PR and
//                  head commit. Railway deploys on merge; the restart follows.
//
// Why the server owns the clock: GitHub's `schedule:` runs late by hours under load
// (see lootify-cron.ts), and a merge that lands at 05:40 instead of 03:00 breaks the
// one promise the banner makes. A workflow_dispatch starts within seconds.
//
// The promise is kept in both directions — nothing merges at a time the banner did
// not announce:
//   • a new commit on the PR (a newer release landing while the bump is open)
//     reschedules from scratch, so the notice period restarts;
//   • a `hold` label (the admin's Hold button, or set by hand on GitHub) pauses it,
//     and releasing the hold reschedules from scratch too;
//   • a missed slot (this server was down at 03:00) is NOT caught up — it moves to
//     the next night, past the grace window, rather than restarting at 05:00;
//   • merge-window.yml re-checks the label and refuses a moved head commit.

const STATE_FILE = 'lich-update.json'
const POLL_MS = 5 * 60_000
const MAX_SLEEP_MS = 60_000
const RETRY_DELAYS_MS = [30_000, 120_000]
/** How long after the slot a merge may still start — covers dispatch retries and a
 *  late timer, nothing more. Past it, the slot is missed and moves a night. */
const GRACE_MS = 15 * 60_000
/** After the merge dispatch, how long to keep saying "restarting now" before giving
 *  up on the restart (a failed Railway build keeps the old deploy running). */
const MERGING_TIMEOUT_MS = 60 * 60_000

const ENABLED        = process.env['MAGILOOM_LICH_UPDATE_ENABLED'] === '1'
const REPO           = process.env['MAGILOOM_LICH_UPDATE_REPO']  ?? 'jackfperryjr/magiserver'
const REF            = process.env['MAGILOOM_LICH_UPDATE_REF']   ?? 'main'
const CHECK_WORKFLOW = 'lich-update-check.yml'
const MERGE_WORKFLOW = 'merge-window.yml'
const LABEL          = 'lich-update'
const HOLD_LABEL     = 'hold'
const CHECK_AT       = process.env['MAGILOOM_LICH_CHECK_AT']     ?? '10:00'
const MERGE_AT       = process.env['MAGILOOM_LICH_MERGE_AT']     ?? '03:00'
const TZ             = process.env['MAGILOOM_LICH_UPDATE_TZ']    ?? 'America/Chicago'
const MIN_NOTICE_MS  = Number(process.env['MAGILOOM_LICH_MIN_NOTICE_HOURS'] ?? 6) * 3600_000

type Phase = 'scheduled' | 'held' | 'merging'

interface Pending {
  pr: number
  url: string
  title: string
  from: string | null
  to: string | null
  /** Head commit the schedule was announced for. A different one reschedules. */
  sha: string
  mergeAt: number
  phase: Phase
  /** When the merge dispatch went out (phase 'merging'). */
  mergingSince: number | null
}

interface Outcome { at: number; ok: boolean; error: string | null }

interface State {
  pending: Pending | null
  lastCheck: Outcome | null
  lastMerge: (Outcome & { pr: number | null }) | null
  lastPoll: Outcome | null
}

/** What clients see. Held schedules are only shown to admins (see notice()). */
export interface MaintenanceNotice {
  kind: 'lich-update'
  phase: Phase
  /** Epoch ms of the merge; the restart follows within minutes. */
  at: number
  from: string | null
  to: string | null
}

export interface LichUpdateStatus extends State {
  enabled: boolean
  armed: boolean
  auth: 'app' | 'pat' | null
  repo: string
  checkAt: string
  mergeAt: string
  tz: string
  nextCheck: number | null
}

let auth: GitHubAuth | null = null
let statePath = ''
let state: State = { pending: null, lastCheck: null, lastMerge: null, lastPoll: null }
let nextCheck: number | null = null
let nextPoll = 0
let timer: ReturnType<typeof setTimeout> | null = null
let started = false
let merging = false
let polling: Promise<void> | null = null

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[lich-update] ${msg}`)
}

function loadState(): void {
  if (!existsSync(statePath)) return
  try {
    state = { ...state, ...JSON.parse(readFileSync(statePath, 'utf8')) as Partial<State> }
  } catch { /* a corrupt file only loses the schedule; the next poll rebuilds one */ }
}

function saveState(): void {
  try { writeFileSync(statePath, JSON.stringify(state, null, 2)) }
  catch (err) { log(`could not persist state: ${String(err)}`) }
}

function time(s: string, fallback: string, name: string): { hh: number; mm: number } {
  const t = parseHHMM(s)
  if (t) return t
  log(`${name}="${s}" is not HH:MM — using ${fallback}`)
  return parseHHMM(fallback)!
}
const checkTime = (): { hh: number; mm: number } => time(CHECK_AT, '10:00', 'MAGILOOM_LICH_CHECK_AT')
const mergeTime = (): { hh: number; mm: number } => time(MERGE_AT, '03:00', 'MAGILOOM_LICH_MERGE_AT')

/** The merge slot for a schedule fixed at `from`: the first MERGE_AT at least
 *  MIN_NOTICE_MS away. Exported for the test. */
export function slotFor(from: number, tz = TZ, at = mergeTime(), noticeMs = MIN_NOTICE_MS): number {
  return nextAfter(from + noticeMs, tz, at.hh, at.mm)
}

/** "Bump Lich v5.24.0 → v5.25.0" (lich-update-check.yml's title) → the two tags. */
export function parseBumpTitle(title: string): { from: string | null; to: string | null } {
  const m = /(v?\d+(?:\.\d+)+\S*)\s*(?:→|->)\s*(v?\d+(?:\.\d+)+\S*)/.exec(title)
  return m ? { from: m[1]!, to: m[2]! } : { from: null, to: null }
}

interface GhPull {
  number: number
  title: string
  html_url: string
  draft?: boolean
  head: { sha: string }
  labels: { name: string }[]
}

async function openBump(): Promise<GhPull | null> {
  const pulls = await githubRequest(auth!, 'GET', `/repos/${REPO}/pulls?state=open&per_page=50`) as GhPull[]
  // Oldest first, so if two ever carried the label the earlier one is the one shown.
  return pulls
    .filter(p => p.labels.some(l => l.name === LABEL))
    .sort((a, b) => a.number - b.number)[0] ?? null
}

/**
 * Pure reconcile step: given what is on GitHub now and what we last announced,
 * decide what to announce next. Exported for the test — every rule about when a
 * schedule moves lives here.
 */
export function reconcile(prev: Pending | null, pr: GhPull | null, now: number, slot: (from: number) => number): Pending | null {
  if (!pr) {
    // The PR merged (or closed) under us. While a merge we started is in flight the
    // restart is still coming, so keep saying so until it lands or times out.
    if (prev?.phase === 'merging' && prev.mergingSince != null && now - prev.mergingSince < MERGING_TIMEOUT_MS) return prev
    return null
  }
  const held = !!pr.draft || pr.labels.some(l => l.name === HOLD_LABEL)
  const base = { pr: pr.number, url: pr.html_url, title: pr.title, sha: pr.head.sha, ...parseBumpTitle(pr.title) }

  const fresh = !prev || prev.pr !== pr.number || prev.sha !== pr.head.sha
  if (fresh) return { ...base, mergeAt: slot(now), phase: held ? 'held' : 'scheduled', mergingSince: null }
  if (held) return { ...prev, ...base, phase: 'held', mergingSince: null }
  // Hold released: a fresh notice period, never "merging in 4 minutes" out of nowhere.
  if (prev.phase === 'held') return { ...prev, ...base, mergeAt: slot(now), phase: 'scheduled' }
  if (prev.phase === 'merging') {
    // Still open long after we dispatched — the workflow refused it (failing checks,
    // conflict) or failed. Try again on the next slot, with the usual notice.
    if (prev.mergingSince != null && now - prev.mergingSince > MERGING_TIMEOUT_MS) {
      return { ...prev, ...base, mergeAt: slot(now), phase: 'scheduled', mergingSince: null }
    }
    return { ...prev, ...base }
  }
  // Missed the slot entirely (server down across it): next night, not now.
  if (now > prev.mergeAt + GRACE_MS) return { ...prev, ...base, mergeAt: slot(now) }
  return { ...prev, ...base }
}

async function poll(): Promise<void> {
  if (!auth) return
  if (polling) return polling
  polling = (async () => {
    try {
      const pr = await openBump()
      const before = state.pending
      state.pending = reconcile(before, pr, Date.now(), from => slotFor(from))
      state.lastPoll = { at: Date.now(), ok: true, error: null }
      const p = state.pending
      if (p && (!before || before.mergeAt !== p.mergeAt || before.phase !== p.phase)) {
        log(`#${p.pr} ${p.title}: ${p.phase}${p.phase === 'scheduled' ? ` for ${new Date(p.mergeAt).toISOString()}` : ''}`)
      } else if (!p && before) {
        log(`#${before.pr} no longer pending`)
      }
    } catch (err) {
      state.lastPoll = { at: Date.now(), ok: false, error: err instanceof Error ? err.message : String(err) }
      log(`poll failed: ${state.lastPoll.error}`)
    } finally {
      saveState()
      nextPoll = Date.now() + POLL_MS
      polling = null
    }
  })()
  return polling
}

async function withRetry(what: string, fn: () => Promise<void>): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try { await fn(); return null } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const delay = RETRY_DELAYS_MS[attempt]
      if (delay == null) { log(`${what} failed permanently: ${message}`); return message }
      log(`${what} failed (${message}) — retrying in ${Math.round(delay / 1000)}s`)
      await new Promise(r => setTimeout(r, delay).unref())
    }
  }
}

async function runCheck(reason: string): Promise<Outcome> {
  const error = await withRetry('check dispatch', () => dispatchWorkflow(auth!, REPO, CHECK_WORKFLOW, REF))
  state.lastCheck = { at: Date.now(), ok: !error, error }
  saveState()
  if (!error) {
    log(`dispatched ${CHECK_WORKFLOW} (${reason})`)
    // The workflow builds and smoke-tests an image before it opens anything, which
    // takes a while; look again sooner than the regular cadence so the banner shows.
    nextPoll = Math.min(nextPoll, Date.now() + 2 * 60_000)
  }
  return state.lastCheck
}

async function runMerge(): Promise<void> {
  if (merging) return
  merging = true
  try {
    // Re-read GitHub right before acting: a hold or a new commit in the last five
    // minutes must win over the schedule we had cached.
    await poll()
    const p = state.pending
    if (!p || p.phase !== 'scheduled' || Date.now() < p.mergeAt) return
    if (Date.now() > p.mergeAt + GRACE_MS) return   // reconcile moves it a night
    const error = await withRetry('merge dispatch', () =>
      dispatchWorkflow(auth!, REPO, MERGE_WORKFLOW, REF, { pr: String(p.pr), sha: p.sha }))
    state.lastMerge = { at: Date.now(), ok: !error, error, pr: p.pr }
    if (!error) {
      state.pending = { ...p, phase: 'merging', mergingSince: Date.now() }
      log(`dispatched ${MERGE_WORKFLOW} for #${p.pr} @ ${p.sha.slice(0, 7)}`)
    } else {
      state.pending = { ...p, mergeAt: slotFor(Date.now()) }
      log(`#${p.pr} moved to ${new Date(state.pending.mergeAt).toISOString()} after a failed dispatch`)
    }
    saveState()
  } finally {
    merging = false
  }
}

function tick(): void {
  const now = Date.now()
  if (nextCheck != null && now >= nextCheck) {
    const { hh, mm } = checkTime()
    nextCheck = nextAfter(now, TZ, hh, mm)
    void runCheck('scheduled')
  }
  const p = state.pending
  if (p?.phase === 'scheduled' && now >= p.mergeAt) void runMerge()
  else if (now >= nextPoll) void poll()
  timer = setTimeout(tick, MAX_SLEEP_MS)
  timer.unref()
}

/** Start the schedule. A no-op unless MAGILOOM_LICH_UPDATE_ENABLED=1 and a GitHub
 *  credential is configured that can reach REPO. */
export function startLichUpdateCron(dataDir: string): void {
  if (started || !ENABLED) return
  auth = resolveGitHubAuth(REPO)
  if (!auth) {
    log('enabled but no GitHub credential — set MAGILOOM_GITHUB_APP_ID + MAGILOOM_GITHUB_APP_KEY')
    return
  }
  started = true
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  statePath = join(dataDir, STATE_FILE)
  loadState()
  // Booting with a merge in flight means this IS the restart it was waiting for (or
  // the old process died). Either way the PR's own state now decides; poll() below
  // drops it if merged and reschedules it if somehow still open.
  if (state.pending?.phase === 'merging') {
    log(`booted after merging #${state.pending.pr}`)
    state.pending = { ...state.pending, mergingSince: 0 }
  }
  const { hh, mm } = checkTime()
  nextCheck = nextAfter(Date.now(), TZ, hh, mm)
  log(`armed via ${auth.kind} auth — checks at ${CHECK_AT}, merges at ${MERGE_AT} ${TZ}; next check ${new Date(nextCheck).toISOString()}`)
  void poll()
  tick()
}

export function stopLichUpdateCron(): void {
  if (timer) clearTimeout(timer)
  timer = null
  started = false
}

/** The banner feed. Players see a scheduled or in-progress restart; a held one is
 *  not a restart anyone needs warning about, so only admins (who can release it) see it. */
export function maintenanceNotice(admin: boolean): MaintenanceNotice | null {
  const p = state.pending
  if (!p || (p.phase === 'held' && !admin)) return null
  return { kind: 'lich-update', phase: p.phase, at: p.mergeAt, from: p.from, to: p.to }
}

/** Admin Hold / Resume: toggles the `hold` label on the PR, then re-reads it so the
 *  answer reflects GitHub, not our intent. */
export async function setLichUpdateHold(hold: boolean): Promise<{ ok: boolean; error?: string; notice?: MaintenanceNotice | null }> {
  if (!auth) return { ok: false, error: 'Lich update scheduling is not configured on this server.' }
  await poll()
  const p = state.pending
  if (!p) return { ok: false, error: 'There is no pending Lich update.' }
  if (p.phase === 'merging') return { ok: false, error: 'The update is already merging.' }
  try {
    if (hold) {
      await githubRequest(auth, 'POST', `/repos/${REPO}/issues/${p.pr}/labels`, { labels: [HOLD_LABEL] })
    } else {
      await githubRequest(auth, 'DELETE', `/repos/${REPO}/issues/${p.pr}/labels/${HOLD_LABEL}`)
        .catch((err: Error) => { if (!/-> 404/.test(err.message)) throw err })   // already gone
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  log(`#${p.pr} ${hold ? 'held' : 'released'} by an admin`)
  await poll()
  return { ok: true, notice: maintenanceNotice(true) }
}

/** /admin "Check now" — runs the release check outside its 10:00 slot. */
export async function triggerLichCheckNow(): Promise<{ ok: boolean; error?: string }> {
  if (!auth) return { ok: false, error: 'Lich update scheduling is not configured on this server.' }
  const r = await runCheck('manual')
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'dispatch failed' }
}

export function lichUpdateStatus(): LichUpdateStatus {
  return {
    ...state,
    enabled: ENABLED,
    armed: started,
    auth: auth?.kind ?? null,
    repo: REPO, checkAt: CHECK_AT, mergeAt: MERGE_AT, tz: TZ,
    nextCheck,
  }
}
