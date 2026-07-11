import { join } from 'path'
import { SettingsStore } from './lib/settings-store'
import { BroadcastBus } from './lib/broadcast-bus'
import { LogStore } from './lib/log-store'

// ── Per-user data isolation ─────────────────────────────────────────────────────
// The desktop app kept ONE settings.json for a single person (holding several
// Simu accounts). A multi-user server must isolate users: each gets their own
// directory under DATA_DIR/users/<id>/ with their own settings/passwords/
// characters, their own multi-box broadcast bus (a user links THEIR characters,
// never a stranger's), and their own logs.
//
// The world MAP is deliberately NOT here — it's a single shared database so every
// explorer's mapping accumulates into one community map, exactly like the desktop
// "shared map DB". Pass the global MapStore into Session separately.
//
// Scaling: this is plain JSON, one small file per user — fine for 500+ users. No
// Postgres needed; revisit only if settings ever grow relational.

export interface UserContext {
  userId:    string
  dir:       string
  settings:  SettingsStore
  broadcast: BroadcastBus
  log:       LogStore
}

export class UserRegistry {
  // Cached so concurrent sessions for the SAME user (phone + desktop at once)
  // share one in-memory SettingsStore — otherwise both would read-modify-write
  // settings.json and clobber each other.
  private readonly cache = new Map<string, UserContext>()

  constructor(private readonly baseDir: string) {}

  /** A filesystem-safe, stable id. Empty/anonymous collapses to "default". */
  static normalize(id: string): string {
    return id.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_') || 'default'
  }

  get(userId: string): UserContext {
    const id = UserRegistry.normalize(userId)
    let ctx = this.cache.get(id)
    if (!ctx) {
      const dir = join(this.baseDir, 'users', id)
      const settings = new SettingsStore(dir)
      const log = new LogStore(dir)
      log.setEnabled(!!settings.get('logging'))
      ctx = { userId: id, dir, settings, broadcast: new BroadcastBus(dir), log }
      this.cache.set(id, ctx)
    }
    return ctx
  }

  dispose(): void {
    for (const c of this.cache.values()) c.broadcast.dispose()
    this.cache.clear()
  }
}
