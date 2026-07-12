import { join } from 'path'
import {
  existsSync, mkdirSync, readdirSync, symlinkSync, copyFileSync, statSync, writeFileSync,
} from 'fs'

// ── Per-user Lich home provisioning ─────────────────────────────────────────────
// Lich stores per-character setup (scripts/profiles/<Char>-setup.yaml), personal
// scripts (scripts/custom/), and a char-keyed SQLite DB (data/lich.db3). Sharing
// one home across users would cross-contaminate settings and cause SQLite lock
// contention, so each user gets an isolated home under DATA_DIR/users/<id>/lich/.
//
// The immutable parts — the Lich engine (lib/, lich.rbw) and the ~237-script
// community library (scripts/*.lic) plus its reference data (scripts/data/) — live
// once in a SHARED read-only base and are SYMLINKED into each user's home, so we
// don't copy hundreds of files per user. Only profiles/ and custom/ are real,
// writable, per-user dirs.
//
// Lich relocates every directory via CLI flags (see lich.rbw): --home, --lib,
// --scripts. We point --lib at the shared base and --scripts at the user's home.

export interface LichHome {
  /** The user's writable home root (LICH_DIR / --home). */
  home: string
  /** Shared, read-only Lich engine dir (--lib). */
  lib: string
  /** The user's script dir (--scripts): symlinked library + their profiles/custom. */
  scripts: string
  /** Absolute path to the shared lich.rbw to launch. */
  lichRbw: string
}

/** Locate the shared read-only Lich install (contains lich.rbw, lib/, scripts/). */
export function sharedLichRoot(): string | null {
  const env = process.env['MAGILOOM_LICH_SHARED']
  const candidates = [
    env ?? '',
    '/opt/lich',
    'C:\\Ruby4Lich5\\Lich5',
    join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', 'lich5'),
  ].filter(Boolean)
  return candidates.find(p => existsSync(join(p, 'lich.rbw'))) ?? null
}

/** Best-effort link: symlink, else copy (Windows without symlink privilege / dev). */
function linkOrCopy(src: string, dest: string): void {
  if (existsSync(dest)) return
  try {
    symlinkSync(src, dest, statSync(src).isDirectory() ? 'junction' : 'file')
  } catch {
    try { if (statSync(src).isFile()) copyFileSync(src, dest) } catch { /* skip */ }
  }
}

/** The user's Lich home root (writable), regardless of shared install. */
export function userLichHome(baseDataDir: string, userId: string): string {
  return join(baseDataDir, 'users', userId, 'lich')
}

/**
 * Create the user's writable Lich dirs (no shared-library linking) and return the
 * script dir. Cheap and install-independent, so the file-management channels can
 * let a user upload/edit profiles + custom scripts before Lich is ever launched.
 */
export function ensureUserScriptsDir(baseDataDir: string, userId: string): string {
  const home = userLichHome(baseDataDir, userId)
  for (const d of ['data', 'maps', 'logs', 'temp', 'backup',
                   'scripts', join('scripts', 'profiles'), join('scripts', 'custom')]) {
    mkdirSync(join(home, d), { recursive: true })
  }
  return join(home, 'scripts')
}

/**
 * Ensure the user's Lich home exists and its shared-library symlinks are in place.
 * Idempotent — safe to call on every launch; new community scripts get linked in
 * on the next run, and the user's own files are never touched.
 *
 * Returns null when no shared Lich install is available (→ caller falls back to
 * direct-connect / a single default home).
 */
export function provisionLichHome(baseDataDir: string, userId: string): LichHome | null {
  const shared = sharedLichRoot()
  if (!shared) return null

  const home = userLichHome(baseDataDir, userId)
  const scripts = ensureUserScriptsDir(baseDataDir, userId)

  // Symlink the shared community library (*.lic) into the user's script dir.
  const sharedScripts = join(shared, 'scripts')
  if (existsSync(sharedScripts)) {
    for (const f of readdirSync(sharedScripts)) {
      if (f.endsWith('.lic')) linkOrCopy(join(sharedScripts, f), join(scripts, f))
    }
    // Shared script reference data (base-*.yaml) as a single dir symlink.
    const sharedData = join(sharedScripts, 'data')
    if (existsSync(sharedData)) linkOrCopy(sharedData, join(scripts, 'data'))
  }

  return { home, lib: join(shared, 'lib'), scripts, lichRbw: join(shared, 'lich.rbw') }
}

// Double-quoted YAML scalar with the two escapes YAML actually requires.
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Write Lich's saved-login file at <home>/data/entry.yaml (DATA_DIR under --home),
 * so `lich --login <Char> --headless=<port>` can authenticate with no frontend and
 * no game key forwarded from us — which is what lets many Lich sessions run at once
 * (each gets its own detachable port instead of all fighting for 127.0.0.1:11024).
 *
 * Plaintext, matching Lich's own default store; the file lives inside this user's
 * isolated, path-jailed home and is 0600. game_code is DR (this server is DR-only).
 */
export function writeLichEntry(
  home: string, account: string, password: string, charName: string,
): void {
  const acct = account.trim().toUpperCase()
  const char = charName.trim().replace(/^(.)(.*)$/, (_m, a: string, b: string) => a.toUpperCase() + b.toLowerCase())
  const yaml =
`# Lich 5 Login Entries - YAML Format
encryption_mode: plaintext
master_password_validation_test:
accounts:
  ${yamlQuote(acct)}:
    password: ${yamlQuote(password)}
    characters:
    - char_name: ${yamlQuote(char)}
      game_code: "DR"
      game_name: "DragonRealms"
      frontend: "stormfront"
      custom_launch:
      custom_launch_dir:
      is_favorite: false
`
  const dataDir = join(home, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'entry.yaml'), yaml, { mode: 0o600 })
}
