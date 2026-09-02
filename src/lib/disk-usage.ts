import { join } from 'path'
import { existsSync, readdirSync, statfsSync } from 'fs'
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

export interface LichLogUsage {
  bytes: number
  users: number
  /** Heaviest accounts, biggest first — who to look at when the bar goes red. */
  top:   { userId: string; bytes: number; overCeiling: boolean }[]
  /** Per-user ceiling in force, so the dashboard can show what "over" means. */
  ceiling: number
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
  let bytes = 0

  if (existsSync(usersDir)) {
    for (const id of safeList(usersDir)) {
      const home = userLichHome(dataDir, id)
      if (!existsSync(lichLogsDir(home))) continue
      const b = lichLogBytes(home)
      bytes += b
      rows.push({ userId: id, bytes: b, overCeiling: b > MAX_BYTES_PER_USER })
    }
  }

  rows.sort((a, b) => b.bytes - a.bytes)
  const value: LichLogUsage = {
    bytes,
    users: rows.length,
    top: rows.slice(0, topN),
    ceiling: MAX_BYTES_PER_USER,
  }
  cache = { at: Date.now(), value }
  return value
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
