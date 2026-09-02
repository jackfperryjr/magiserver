import { join } from 'path'
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'fs'
import { listLichLogs, lichLogsDir, type LichLogEntry } from './lich-log-store'
import { userLichHome } from '../lich-home'

// ── Lich session-log retention ──────────────────────────────────────────────────
// Lich opens a fresh log pair every time it reconnects and never removes one, so a
// user's home grows without bound — a full /data is what this exists to prevent.
// Measured on a real install: 470 .xml over two months of play came to 690 MB, one
// character accounting for 674 MB of it at ~2.1 MB per session.
//
// Retention is expressed in DAYS because that is what a person can reason about,
// but days do not bound bytes: the same install showed 22 active days inside 61
// calendar days and a single 12-day burst holding most of the total. So the age
// limit is paired with a per-user BYTE CEILING that prunes oldest-first, and it is
// the ceiling — not the day count — that actually protects the volume.
//
// The ceiling carries real weight rather than being a backstop, because whether a
// user keeps the flattened `.log` is THEIR call (it's set per character in Lich's
// own setup YAML) and not something the server can assume. On the measured install
// one character with `.log` left on wrote 2.5 GB in two months, ~40 MB/day, which
// alone exceeds the ceiling inside a fortnight. Nothing is lost by pruning early:
// logs can be downloaded from the client for as long as they're held.
//
// DELETION SAFETY. Candidates come from listLichLogs, which only ever yields paths
// matching Lich's exact naming shape (see LICH_PATH_RE). Nothing else in the tree
// is representable as a candidate, so a user file that merely happens to sit under
// logs/ can't be selected, and the root is always derived from the account id.

/** Operator ceiling on the user-facing setting. */
export const MAX_RETENTION_DAYS =
  Number(process.env['MAGILOOM_LICH_LOG_MAX_DAYS'] ?? 14)

/** Per-user byte ceiling, enforced regardless of the day setting. */
export const MAX_BYTES_PER_USER =
  Number(process.env['MAGILOOM_LICH_LOG_MAX_MB'] ?? 500) * 1024 * 1024

/** Retention used when a user hasn't chosen one. */
export const DEFAULT_RETENTION_DAYS = 7

/** The values the client offers. Anything else is clamped into range, not rejected. */
export const RETENTION_CHOICES = [3, 7, 14] as const

/** Clamp a stored/requested retention to something the operator allows. */
export function clampRetentionDays(days: unknown): number {
  const n = Math.floor(Number(days))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS
  return Math.min(n, MAX_RETENTION_DAYS)
}

export interface PruneOptions {
  /** Delete logs older than this many days. Clamped to MAX_RETENTION_DAYS. */
  maxAgeDays?: number
  /** Per-user ceiling; oldest are removed until the total fits. */
  maxBytes?: number
  /**
   * Also delete every flattened `.log`, ignoring age. Lich writes one alongside
   * each `.xml` with no per-line timestamps, so nothing can be measured from it —
   * and it is the bulk of the bytes. Off by default: automatic pruning shouldn't
   * silently widen its own remit. The CLI opts in with --drop-flattened.
   */
  dropFlattened?: boolean
  /** Report what would go without touching the disk. */
  dryRun?: boolean
}

export interface PruneResult {
  /** Files removed (or that would be, under dryRun). */
  removed: number
  /** Bytes reclaimed. */
  bytes: number
  /** Bytes still on disk afterwards. */
  remaining: number
  /** Set when the byte ceiling had to remove files the age limit would have kept. */
  hitByteCeiling: boolean
}

const EMPTY: PruneResult = { removed: 0, bytes: 0, remaining: 0, hitByteCeiling: false }

/**
 * Prune one user's Lich logs. Age first, then the byte ceiling on what survives.
 * Best-effort throughout: a file that can't be removed is left and counted as
 * remaining, because failing to prune must never take a session down.
 */
export function pruneLichLogs(lichHome: string, opts: PruneOptions = {}): PruneResult {
  const root = lichLogsDir(lichHome)
  if (!existsSync(root)) return { ...EMPTY }

  const {
    maxAgeDays = DEFAULT_RETENTION_DAYS,
    maxBytes = MAX_BYTES_PER_USER,
    dropFlattened = false,
    dryRun = false,
  } = opts

  // xmlOnly:false — retention covers both halves of the pair. The limit is lifted
  // because a partial listing would silently under-prune the largest accounts.
  let all: LichLogEntry[]
  try {
    all = listLichLogs(lichHome, { xmlOnly: false, limit: Number.MAX_SAFE_INTEGER })
  } catch {
    return { ...EMPTY }
  }
  if (!all.length) return { ...EMPTY }

  const cutoff = Date.now() - clampRetentionDays(maxAgeDays) * 86_400_000
  const doomed = new Set<LichLogEntry>()

  for (const e of all) {
    if (e.mtime < cutoff) doomed.add(e)
    else if (dropFlattened && !e.xml) doomed.add(e)
  }

  // Byte ceiling over the survivors, oldest first. listLichLogs sorts newest-first,
  // so walking from the end retires the least useful sessions before recent ones.
  let hitByteCeiling = false
  const survivors = all.filter(e => !doomed.has(e))
  let total = survivors.reduce((s, e) => s + e.size, 0)
  if (total > maxBytes) {
    hitByteCeiling = true
    for (let i = survivors.length - 1; i >= 0 && total > maxBytes; i--) {
      const e = survivors[i]!
      doomed.add(e)
      total -= e.size
    }
  }

  let removed = 0, bytes = 0
  if (!dryRun) {
    for (const e of doomed) {
      try {
        unlinkSync(join(root, ...e.path.split('/')))
        removed++
        bytes += e.size
      } catch { /* left in place; still counted against `remaining` below */ }
    }
    pruneEmptyDirs(root)
  } else {
    for (const e of doomed) { removed++; bytes += e.size }
  }

  const startTotal = all.reduce((s, e) => s + e.size, 0)
  return { removed, bytes, remaining: startTotal - bytes, hitByteCeiling }
}

/**
 * Prune every user under DATA_DIR/users/. `retentionFor` lets the caller resolve
 * each user's own setting; users with no Lich home are skipped silently.
 */
export function pruneAllUsers(
  dataDir: string,
  retentionFor: (userId: string) => number = () => DEFAULT_RETENTION_DAYS,
  opts: Omit<PruneOptions, 'maxAgeDays'> = {},
): { users: number; removed: number; bytes: number } {
  const usersDir = join(dataDir, 'users')
  if (!existsSync(usersDir)) return { users: 0, removed: 0, bytes: 0 }

  let users = 0, removed = 0, bytes = 0
  for (const id of safeList(usersDir)) {
    const home = userLichHome(dataDir, id)
    if (!existsSync(lichLogsDir(home))) continue
    const r = pruneLichLogs(home, { ...opts, maxAgeDays: retentionFor(id) })
    users++
    removed += r.removed
    bytes += r.bytes
  }
  return { users, removed, bytes }
}

/** Total bytes of Lich logs a user is holding — for the admin gauge and tests. */
export function lichLogBytes(lichHome: string): number {
  try {
    return listLichLogs(lichHome, { xmlOnly: false, limit: Number.MAX_SAFE_INTEGER })
      .reduce((s, e) => s + e.size, 0)
  } catch { return 0 }
}

// Lich's tree is char/year/month; pruning a month can empty all three. Walk bottom
// -up and remove only what is genuinely empty, so a still-populated year survives.
function pruneEmptyDirs(root: string): void {
  for (const charDir of safeList(root)) {
    const charPath = join(root, charDir)
    if (!isDir(charPath)) continue
    for (const year of safeList(charPath)) {
      const yearPath = join(charPath, year)
      if (!isDir(yearPath)) continue
      for (const month of safeList(yearPath)) {
        rmdirIfEmpty(join(yearPath, month))
      }
      rmdirIfEmpty(yearPath)
    }
    rmdirIfEmpty(charPath)
  }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function rmdirIfEmpty(p: string): void {
  try { if (isDir(p) && readdirSync(p).length === 0) rmdirSync(p) } catch { /* keep */ }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
