// Shared by every "fire at HH:MM local" job on this server (lootify-cron.ts,
// lich-update-cron.ts). Extracted from lootify-cron.ts; test-lootify-cron.ts still
// asserts it against real DST transitions through that module's re-exports.

// ── Wall-clock arithmetic in a named timezone ───────────────────────────────────
// Done through Intl rather than a fixed UTC offset so DST is the tz database's
// problem, not ours. (The old workflow listed both offsets and used `date +%z` to
// drop the wrong one twice a year; this is that whole mechanism, deleted.)

interface Parts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsAt(t: number, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const out: Record<string, number> = {}
  for (const { type, value } of fmt.formatToParts(t)) if (type !== 'literal') out[type] = Number(value)
  return {
    year: out['year'] ?? 1970, month: out['month'] ?? 1, day: out['day'] ?? 1,
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: (out['hour'] ?? 0) % 24, minute: out['minute'] ?? 0, second: out['second'] ?? 0,
  }
}

/** Offset of `tz` from UTC at instant `t`, in ms (positive east of Greenwich). */
function offsetAt(t: number, tz: string): number {
  const p = partsAt(t, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - (t - (t % 1000))
}

/** The UTC instant at which the clock in `tz` reads the given local date and time.
 *  The offset is applied twice: the first pass can use the wrong side of a DST
 *  transition, and re-reading it at the corrected instant settles it. */
function instantOf(y: number, mo: number, d: number, hh: number, mm: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, hh, mm, 0)
  const once = naive - offsetAt(naive, tz)
  return naive - offsetAt(once, tz)
}

export function dayKey(t: number, tz: string): string {
  const p = partsAt(t, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Today's target instant in `tz`, whether or not it has already passed. */
export function targetOn(t: number, tz: string, hh: number, mm: number): number {
  const p = partsAt(t, tz)
  return instantOf(p.year, p.month, p.day, hh, mm, tz)
}

/** The next target strictly after `from`. Exported for test-lootify-cron.ts: the DST
 *  behaviour is the whole reason this file does its own clock arithmetic, so it is
 *  worth asserting against real transition dates rather than trusting on read. */
export function nextAfter(from: number, tz: string, hh: number, mm: number): number {
  const today = targetOn(from, tz, hh, mm)
  if (today > from) return today
  const p = partsAt(from, tz)
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86_400_000)
  return instantOf(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hh, mm, tz)
}

/** Parse "HH:MM" (24h). Null when malformed, so each caller can log its own env name. */
export function parseHHMM(s: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const hh = Number(m[1]), mm = Number(m[2])
  return hh > 23 || mm > 59 ? null : { hh, mm }
}
