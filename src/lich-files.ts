import { join, resolve, sep } from 'path'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync,
} from 'fs'

// ── User-editable Lich files (path-jailed) ──────────────────────────────────────
// The PWA edits/uploads a user's Lich setup through these. ONLY two dirs under the
// user's script dir are writable: profiles/ (<Char>-setup.yaml) and custom/ (their
// own .lic scripts). The symlinked community library, lib/, and scripts/data/ are
// never exposed. Every path is confined to those two dirs, so a crafted
// "../../etc/passwd" or absolute path can't escape.

export type EditableDir = 'profiles' | 'custom'
const ROOTS: EditableDir[] = ['profiles', 'custom']

export interface LichFileEntry {
  dir: EditableDir
  name: string
  size: number
  mtime: number
}

/**
 * Resolve `rel` (e.g. "profiles/Caerla-setup.yaml") to an absolute path and prove
 * it stays inside profiles/ or custom/. Throws otherwise.
 */
function jail(scriptsDir: string, rel: string): string {
  const target = resolve(scriptsDir, rel)
  const ok = ROOTS.some(r => {
    const root = resolve(scriptsDir, r)
    return target === root || target.startsWith(root + sep)
  })
  if (!ok) throw new Error('Path not allowed: must be within profiles/ or custom/')
  return target
}

/** List every file in the user's profiles/ and custom/ dirs. */
export function listFiles(scriptsDir: string): LichFileEntry[] {
  const out: LichFileEntry[] = []
  for (const dir of ROOTS) {
    const abs = join(scriptsDir, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      try {
        const st = statSync(join(abs, name))
        if (st.isFile()) out.push({ dir, name, size: st.size, mtime: st.mtimeMs })
      } catch { /* skip unreadable */ }
    }
  }
  return out
}

/** Read one editable file's text. */
export function readFile(scriptsDir: string, rel: string): { path: string; content: string } {
  const abs = jail(scriptsDir, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error('Not found: ' + rel)
  return { path: rel, content: readFileSync(abs, 'utf8') }
}

/** Create or overwrite an editable file (used for both in-app edits and uploads). */
export function writeFile(scriptsDir: string, rel: string, content: string): { path: string } {
  const abs = jail(scriptsDir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return { path: rel }
}

/** Delete an editable file. */
export function deleteFile(scriptsDir: string, rel: string): { path: string } {
  const abs = jail(scriptsDir, rel)
  if (existsSync(abs)) rmSync(abs)
  return { path: rel }
}
