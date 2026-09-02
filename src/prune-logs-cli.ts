import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import { SettingsStore } from './lib/settings-store'
import { lichLogsDir } from './lib/lich-log-store'
import { userLichHome } from './lich-home'
import {
  pruneLichLogs, clampRetentionDays, lichLogBytes,
  DEFAULT_RETENTION_DAYS, MAX_BYTES_PER_USER, MAX_RETENTION_DAYS,
} from './lib/lich-log-prune'

// ── One-off Lich log prune ──────────────────────────────────────────────────────
// The server prunes at boot and every six hours (src/index.ts). This is the manual
// door onto the same code, for two jobs the scheduled pass deliberately won't do:
// clearing a backlog with --drop-flattened, and answering "what would go?" without
// deleting anything.
//
//   npm run prune-logs -- --dry-run
//   npm run prune-logs -- --days=7
//   npm run prune-logs -- --drop-flattened      # every .log, any age
//
// Defaults to a DRY RUN when --drop-flattened is passed without --yes, because that
// flag ignores age and is the one combination that can remove a lot at once.

interface Args {
  days?: number
  dropFlattened: boolean
  dryRun: boolean
  user?: string
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dropFlattened: false, dryRun: false }
  for (const a of argv) {
    const days = /^--days=(\d+)$/.exec(a)
    const user = /^--user=(.+)$/.exec(a)
    if (days) out.days = Number(days[1])
    else if (user) out.user = user[1]
    else if (a === '--drop-flattened') out.dropFlattened = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--yes') out.dryRun = false
    else if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else { console.error(`unknown argument: ${a}`); usage(); process.exit(2) }
  }
  // --drop-flattened is the destructive one; make the user say --yes to it.
  if (out.dropFlattened && !argv.includes('--yes')) out.dryRun = true
  return out
}

function usage(): void {
  console.log(`
Prune Lich session logs under MAGILOOM_DATA_DIR.

  --days=N           retention in days (default ${DEFAULT_RETENTION_DAYS}, operator max ${MAX_RETENTION_DAYS})
  --user=ID          only this user id (default: every user)
  --drop-flattened   also delete every .log regardless of age; implies --dry-run
                     unless --yes is also given
  --dry-run          report only, delete nothing
  --yes              actually delete when --drop-flattened is set

Per-user byte ceiling: ${(MAX_BYTES_PER_USER / 1048576).toFixed(0)} MB (MAGILOOM_LICH_LOG_MAX_MB)
`.trim())
}

const mb = (n: number): string => (n / 1048576).toFixed(1).padStart(8) + ' MB'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = process.env['MAGILOOM_DATA_DIR'] ?? join(process.cwd(), 'data')
  const usersDir = join(dataDir, 'users')

  if (!existsSync(usersDir)) {
    console.error(`no users directory at ${usersDir} — is MAGILOOM_DATA_DIR set?`)
    process.exit(1)
  }

  const ids = (args.user ? [args.user] : readdirSync(usersDir))
    .filter(id => existsSync(lichLogsDir(userLichHome(dataDir, id))))

  if (!ids.length) { console.log('No user has any Lich logs.'); return }

  console.log(`${args.dryRun ? 'DRY RUN — nothing will be deleted' : 'Pruning'}` +
    `  (data dir: ${dataDir})\n`)

  let totalBefore = 0, totalFreed = 0, totalRemoved = 0
  for (const id of ids) {
    const home = userLichHome(dataDir, id)
    // Each user's own setting unless --days overrides it for this run.
    const days = clampRetentionDays(
      args.days ?? new SettingsStore(join(dataDir, 'users', id)).get('lichLogRetentionDays'))

    const before = lichLogBytes(home)
    const r = pruneLichLogs(home, {
      maxAgeDays: days,
      dropFlattened: args.dropFlattened,
      dryRun: args.dryRun,
    })

    totalBefore += before
    totalFreed += r.bytes
    totalRemoved += r.removed

    console.log(
      `  ${id.padEnd(24)} ${mb(before)} → ${mb(r.remaining)}` +
      `  (${String(r.removed).padStart(4)} files, ${days}d${r.hitByteCeiling ? ', hit byte ceiling' : ''})`)
  }

  console.log(
    `\n${args.dryRun ? 'Would reclaim' : 'Reclaimed'} ${(totalFreed / 1048576).toFixed(0)} MB ` +
    `from ${totalRemoved} file(s) across ${ids.length} user(s); ` +
    `${((totalBefore - totalFreed) / 1048576).toFixed(0)} MB remaining.`)

  if (args.dryRun && args.dropFlattened) console.log('Re-run with --yes to apply.')
}

main()
