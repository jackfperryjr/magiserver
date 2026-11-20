/* Scheduling rules behind the Lich-update restart banner — run: npx tsx test-lich-update.ts
 *
 * The banner makes one promise: the server restarts at the time it shows, never
 * earlier and never unannounced. Every rule that moves that time lives in
 * reconcile(), so this walks it through each case. */
import { slotFor, parseBumpTitle, reconcile } from './src/lich-update-cron'
import { dayKey } from './src/lib/zoned-clock'

const TZ = 'America/Chicago'
const AT = { hh: 3, mm: 0 }
const SIX_H = 6 * 3600_000
let failures = 0
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
  if (!cond) failures++
}
const local = (t: number): string => `${dayKey(t, TZ)} ${new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit',
}).format(t)}`
const slot = (from: number): number => slotFor(from, TZ, AT, SIX_H)

// ── slot math ──
{
  // A 10:00 check (16:00 UTC in CST) → the following night's 03:00.
  const opened = Date.parse('2026-11-20T16:05:00Z')
  check('10:05 opening merges at 03:00 the next morning', local(slot(opened)) === '2026-11-21 03:00')
  // Opened at 22:00: 03:00 is only 5h away, under the notice → the night after.
  const late = Date.parse('2026-11-21T04:00:00Z')            // 22:00 CST on the 20th
  check('22:00 opening skips to the night after (notice < 6h)', local(slot(late)) === '2026-11-22 03:00')
  // Opened 20:59 → 6h01m to 03:00 → tonight.
  const edge = Date.parse('2026-11-21T02:59:00Z')
  check('20:59 opening still makes tonight (6h01m notice)', local(slot(edge)) === '2026-11-21 03:00')
  // Fall-back night: 03:00 still exists and is still 03:00.
  const fb = Date.parse('2026-10-31T15:00:00Z')              // 10:00 CDT Sat
  check('across fall-back, still 03:00 local', local(slot(fb)) === '2026-11-01 03:00')
}

// ── title parsing ──
{
  const t = parseBumpTitle('Bump Lich v5.24.2 → v5.25.0')
  check('parses from/to tags', t.from === 'v5.24.2' && t.to === 'v5.25.0')
  check('unparseable title → nulls', parseBumpTitle('Something else').to === null)
}

// ── reconcile ──
type Pr = Parameters<typeof reconcile>[1]
const pr = (o: Partial<NonNullable<Pr>> = {}): NonNullable<Pr> => ({
  number: 30, title: 'Bump Lich v5.25.0 → v5.26.0', html_url: 'https://x/30',
  head: { sha: 'aaa' }, labels: [{ name: 'lich-update' }], ...o,
})
const t0 = Date.parse('2026-11-20T16:05:00Z')
{
  const a = reconcile(null, pr(), t0, slot)!
  check('first sighting schedules', a.phase === 'scheduled' && local(a.mergeAt) === '2026-11-21 03:00')
  check('carries versions', a.from === 'v5.25.0' && a.to === 'v5.26.0')

  const b = reconcile(a, pr(), t0 + 3600_000, slot)!
  check('later polls keep the same slot', b.mergeAt === a.mergeAt)

  const c = reconcile(a, pr({ head: { sha: 'bbb' } }), t0 + 12 * 3600_000, slot)!   // 22:05 CST
  check('new head commit reschedules from scratch', c.sha === 'bbb' && local(c.mergeAt) === '2026-11-22 03:00')

  const held = reconcile(a, pr({ labels: [{ name: 'lich-update' }, { name: 'hold' }] }), t0 + 3600_000, slot)!
  check('hold label → held', held.phase === 'held')
  check('draft → held', reconcile(a, pr({ draft: true }), t0, slot)!.phase === 'held')

  const resumed = reconcile(held, pr(), t0 + 12 * 3600_000, slot)!                    // 22:05 CST
  check('releasing a hold re-applies the notice period',
    resumed.phase === 'scheduled' && local(resumed.mergeAt) === '2026-11-22 03:00')

  const missed = reconcile(a, pr(), a.mergeAt + 30 * 60_000, slot)!
  check('missed slot moves a night, never catches up', missed.mergeAt > a.mergeAt + 20 * 3600_000)
  const inGrace = reconcile(a, pr(), a.mergeAt + 5 * 60_000, slot)!
  check('inside the grace window the slot stands', inGrace.mergeAt === a.mergeAt)

  check('closed PR clears the schedule', reconcile(a, null, t0, slot) === null)

  const merging = { ...a, phase: 'merging' as const, mergingSince: a.mergeAt }
  check('merged PR keeps "restarting" until the restart',
    reconcile(merging, null, a.mergeAt + 10 * 60_000, slot)?.phase === 'merging')
  check('…but not forever', reconcile(merging, null, a.mergeAt + 2 * 3600_000, slot) === null)
  const stuck = reconcile(merging, pr(), a.mergeAt + 2 * 3600_000, slot)!
  check('a merge the workflow refused goes back on the schedule',
    stuck.phase === 'scheduled' && stuck.mergeAt > a.mergeAt + 20 * 3600_000)
  // What startLichUpdateCron does on boot after merging (mergingSince: 0).
  check('boot after the merge clears it', reconcile({ ...merging, mergingSince: 0 }, null, a.mergeAt + 600_000, slot) === null)
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nALL PASSED')
