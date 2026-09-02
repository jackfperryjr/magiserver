import { join, relative, sep } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import type { Writable } from 'stream'
import { ZipWriter } from './zip'

// ── "Give me everything of mine" export ─────────────────────────────────────────
// A zip of the USER-SPECIFIC half of their Lich home, so someone can take their
// setup with them (or keep a copy before retention removes it) without needing
// shell access to a container they don't have shell access to.
//
// What's included is the stuff that is THEIRS: profiles, custom scripts, Lich's
// per-character data, and their logs. What's excluded is the shared engine — lib/,
// the ~237-script community library, and scripts/data/ — which is symlinked into
// every home from the read-only base (lich-home.ts). Those aren't the user's, are
// identical for everyone, and would turn a small export into tens of MB of files
// they can get from upstream.
//
// SYMLINKS ARE NEVER FOLLOWED. That is what enforces the exclusion — the shared
// library is linked in, so skipping links skips it — and it also means no crafted
// link inside a user's own directory can pull a file from elsewhere on the host
// into their download.

/** Directories inside the Lich home worth exporting, in the order they appear. */
const INCLUDE_DIRS = [
  'scripts/profiles',   // per-character Lich setup
  'scripts/custom',     // the user's own .lic scripts
  'data',               // lich.db3 + per-character yaml
  'logs',               // Lich's session logs
]

/** Skipped inside data/: bulky, re-downloadable, and not authored by the user. */
const SKIP_RE = /^map-\d+\.(?:json|dat|xml)(?:\.bak)?$/i

export interface ExportOptions {
  /** Include Lich's session logs. They dominate the size, so it's worth a choice. */
  includeLogs?: boolean
  /** Refuse to grow past this; the archive is truncated rather than unbounded. */
  maxBytes?: number
}

export interface ExportResult { files: number; bytes: number; truncated: boolean }

/**
 * Stream a zip of `lichHome`'s user-specific contents into `out`. Returns what was
 * actually written — `truncated` when the budget stopped it short, so the caller
 * can say so rather than handing over a silently partial archive.
 */
export function exportUserLichData(
  lichHome: string,
  out: Writable,
  opts: ExportOptions = {},
): ExportResult {
  const { includeLogs = true, maxBytes = 512 * 1024 * 1024 } = opts
  const zip = new ZipWriter(out)
  let files = 0, bytes = 0, truncated = false

  for (const rel of INCLUDE_DIRS) {
    if (!includeLogs && rel === 'logs') continue
    const abs = join(lichHome, ...rel.split('/'))
    if (!existsSync(abs)) continue

    for (const file of walk(abs)) {
      if (bytes >= maxBytes) { truncated = true; break }
      let data: Buffer, mtime: Date
      try {
        const st = statSync(file)
        if (!st.isFile() || SKIP_RE.test(file.split(sep).pop() ?? '')) continue
        if (bytes + st.size > maxBytes) { truncated = true; break }
        data = readFileSync(file)
        mtime = st.mtime
      } catch { continue }

      // Archive paths are relative to the home and always forward-slashed.
      const name = relative(lichHome, file).split(sep).join('/')
      zip.addFile(name, data, mtime)
      files++
      bytes += data.length
    }
    if (truncated) break
  }

  zip.finish()
  return { files, bytes, truncated }
}

/** Depth-first file walk that never traverses or yields a symlink. */
function* walk(dir: string): Generator<string> {
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue          // shared library / anything linked in
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) yield p
  }
}
