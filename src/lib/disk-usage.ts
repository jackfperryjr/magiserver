import { join } from 'path'
import { existsSync, readdirSync, statSync, statfsSync } from 'fs'
import { lichLogsDir } from './lich-log-store'
import { lichLogBytes, MAX_BYTES_PER_USER } from './lich-log-prune'
import { userLichHome } from '../lich-home'

// ── Volume usage for the admin dashboard ────────────────────────────────────────
// /data is a Railway Volume, and the failure it produces when full is genuinely
// confusing from the outside: an uncaught writeFileSync throws ENOSPC, gateway.ts
// stringifies it, and a user sees "Error: Error: ENOSPC" in the browser console
// with nothing pointing at the server. Retention (lich-log-prune.ts) keeps it from
// filling; this makes the headroom visible before it matters.
//
// Lich logs get their own line because they are the only thing here that grows
// without a natural bound, so "how full is the disk" and "how much of that is
// logs" are the two numbers worth seeing side by side.

export interface VolumeUsage {
  total: number
  free:  number
  used:  number
  /** 0-100, rounded to one decimal. */
  pct:   number
}

/** The categories under /data that actually grow, kept apart so the dashboard can't
 *  imply the disk is healthy just because one of them is. */
export interface UsageBreakdown {
  /** Lich's own session logs (DR-<Char>/YYYY/MM/*.xml|.log). */
  lichLogs: number
  /** Magiloom's game-output logs + their .jsonl sidecars. */
  magiloomLogs: number
  /** Lich's prime-map downloads under <home>/data/<GAME>/. */
  lichMaps: number
  /** Everything else in the user tree — profiles, custom scripts, lich.db3, backups. */
  otherUser: number
}

export interface LichLogUsage {
  /** Total across every tracked category, i.e. the whole per-user tree. */
  bytes: number
  users: number
  /** Heaviest accounts, biggest first — who to look at when the bar goes red. */
  top:   { userId: string; bytes: number; overCeiling: boolean }[]
  /** Per-user ceiling in force, so the dashboard can show what "over" means. */
  ceiling: number
  /** Where those bytes actually sit. */
  breakdown: UsageBreakdown
}

export interface DiskSnapshot {
  volume:   VolumeUsage | null
  lichLogs: LichLogUsage
  /** When the (cached) log walk was taken. */
  sampledAt: number
}

/**
 * Free/used bytes for the filesystem holding `path`. Returns null rather than
 * throwing: statfs is unavailable on some platforms and a dashboard tile is never
 * worth failing a request over.
 *
 * `bavail` (not `bfree`) is deliberate — it's the space available to an unprivileged
 * writer, which is what the server actually gets, and on ext4 it excludes the
 * root-reserved blocks that would otherwise overstate headroom by ~5%.
 */
export function volumeUsage(path: string): VolumeUsage | null {
  try {
    const s = statfsSync(path)
    const total = s.blocks * s.bsize
    const free  = s.bavail * s.bsize
    if (!total) return null
    const used = total - free
    return { total, free, used, pct: Math.round((used / total) * 1000) / 10 }
  } catch { return null }
}

// Walking every user's log tree touches thousands of files, and /admin polls every
// few seconds — so the walk is cached and the volume figures (cheap) are not.
const CACHE_MS = 60_000
let cache: { at: number; value: LichLogUsage } | null = null

export function lichLogUsage(dataDir: string, topN = 5): LichLogUsage {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value

  const usersDir = join(dataDir, 'users')
  const rows: { userId: string; bytes: number; overCeiling: boolean }[] = []
  const breakdown: UsageBreakdown = { lichLogs: 0, magiloomLogs: 0, lichMaps: 0, otherUser: 0 }
  let bytes = 0

  if (existsSync(usersDir)) {
    for (const id of safeList(usersDir)) {
      const userDir = join(usersDir, id)
      if (!isDir(userDir)) continue
      const home = userLichHome(dataDir, id)

      // Measure the whole user directory, then attribute the parts we know about.
      // Deriving "other" by subtraction rather than walking it separately means the
      // categories always sum to the real total — no silently unaccounted bytes.
      const totalUser = dirBytes(userDir)
      const lich = existsSync(lichLogsDir(home)) ? lichLogBytes(home) : 0
      const mag  = dirBytes(join(userDir, 'logs'))
      const maps = lichMapBytes(home)

      breakdown.lichLogs     += lich
      breakdown.magiloomLogs += mag
      breakdown.lichMaps     += maps
      breakdown.otherUser    += Math.max(0, totalUser - lich - mag - maps)

      if (!totalUser) continue
      bytes += totalUser
      rows.push({ userId: id, bytes: totalUser, overCeiling: lich + mag > MAX_BYTES_PER_USER })
    }
  }

  rows.sort((a, b) => b.bytes - a.bytes)
  const value: LichLogUsage = {
    bytes,
    users: rows.length,
    top: rows.slice(0, topN),
    ceiling: MAX_BYTES_PER_USER,
    breakdown,
  }
  cache = { at: Date.now(), value }
  return value
}

/** Recursive byte total for a directory. Symlinks are NOT followed — each user's
 *  Lich home symlinks the shared read-only library, and counting that per user would
 *  inflate every account by the size of the engine. */
function dirBytes(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()!
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { stack.push(p); continue }
      try { total += statSync(p).size } catch { /* vanished mid-walk */ }
    }
  }
  return total
}

/** Bytes held by Lich's prime-map downloads under <home>/data/<GAME>/. */
function lichMapBytes(lichHome: string): number {
  const dataDir = join(lichHome, 'data')
  if (!existsSync(dataDir)) return 0
  let total = 0
  for (const game of safeList(dataDir)) {
    if (!/^(?:DR|GS)[A-Z]?$/.test(game)) continue
    const gameDir = join(dataDir, game)
    if (!isDir(gameDir)) continue
    for (const f of safeList(gameDir)) {
      if (!/^map-\d+\.(?:json|dat|xml)(?:\.bak)?$/i.test(f)) continue
      try { total += statSync(join(gameDir, f)).size } catch { /* skip */ }
    }
  }
  return total
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** Drop the cached walk — call after pruning so the dashboard reflects it at once. */
export function invalidateDiskCache(): void { cache = null }

export function diskSnapshot(dataDir: string): DiskSnapshot {
  return {
    volume: volumeUsage(dataDir),
    lichLogs: lichLogUsage(dataDir),
    sampledAt: cache?.at ?? Date.now(),
  }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
