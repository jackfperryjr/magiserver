import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'

// ── Per-character messaging store ────────────────────────────────────────────────
// One JSON file per character (`<normName>.json`) holding that character's own view
// of the Magiloom messaging graph: its contacts, the pending friend requests in
// both directions, and its message threads. This is the durable half of the system
// (presence + routing is in-memory in message-hub.ts).
//
// Identity is the CHARACTER NAME, which is self-proving: the only way to have a live
// session as a name is to have passed Simutronics (SGE) auth for it, so the server
// trusts the connected character as the actor and never takes a sender from the wire.
//
// Each character keeps its OWN copy of every message it's part of (so both sides have
// full history independently). Delivery/read flags are meaningful only on the
// RECIPIENT's copy: `delivered` = pushed to a live client at least once (drives the
// offline inbox — undelivered messages are flushed on next connect); `read` = the
// user has opened the thread. On the author's copy both are always true.
//
// Writes are synchronous + atomic (temp file + rename), mirroring settings-store /
// map-store. Plain JSON, one small file per character — no DB, same scaling call as
// the rest of the server (see user-context.ts).

export interface Message {
  id:        string
  from:      string   // sender display name (last-seen casing)
  to:        string   // recipient display name
  body:      string
  ts:        number
  read:      boolean   // recipient has opened the thread since receiving (recipient copy)
  delivered: boolean   // pushed to a live recipient client at least once (recipient copy)
}

export interface ContactRef { name: string; since: number }

export interface ContactBook {
  contacts:   ContactRef[]
  pendingIn:  ContactRef[]   // requests awaiting THIS character's accept
  pendingOut: ContactRef[]   // requests THIS character has sent, awaiting the other's accept
}

interface Persisted {
  self:       string                       // last-seen display casing of this character
  contacts:   Record<string, ContactRef>   // normName → ref
  pendingIn:  Record<string, ContactRef>
  pendingOut: Record<string, ContactRef>
  threads:    Record<string, Message[]>    // normName(peer) → messages (chronological)
}

// Keep threads bounded so a long-lived character's file can't grow without limit.
// The most recent messages are what a client shows; older history is dropped.
const THREAD_CAP = 500
// Defensive cap on a single message body (also enforced at the hub before storing).
const BODY_CAP = 4000

/** Filesystem- and key-safe form of a character name. DR names are single
 *  alphanumeric tokens, so this is mostly a lowercase; the strip is belt-and-braces. */
export function normName(name: string): string {
  return (name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
}

export class MessageStore {
  private readonly file: string
  private readonly key: string
  private data: Persisted

  constructor(dir: string, name: string) {
    this.key  = normName(name)
    this.file = join(dir, `${this.key}.json`)
    this.data = this.load(name)
  }

  // ── identity ───────────────────────────────────────────────────────────────
  self(): string { return this.data.self }

  /** Record the freshest display casing for this character (from a live session). */
  setSelf(name: string): void {
    if (name && name !== this.data.self) { this.data.self = name; this.save() }
  }

  // ── contacts ───────────────────────────────────────────────────────────────
  contacts(): ContactBook {
    return {
      contacts:   Object.values(this.data.contacts),
      pendingIn:  Object.values(this.data.pendingIn),
      pendingOut: Object.values(this.data.pendingOut),
    }
  }

  isContact(name: string): boolean   { return normName(name) in this.data.contacts }
  hasPendingIn(name: string): boolean { return normName(name) in this.data.pendingIn }

  addPendingOut(name: string): void {
    const k = normName(name)
    if (k in this.data.pendingOut) return
    this.data.pendingOut[k] = { name, since: Date.now() }
    this.save()
  }

  addPendingIn(name: string): void {
    const k = normName(name)
    if (k in this.data.pendingIn) return
    this.data.pendingIn[k] = { name, since: Date.now() }
    this.save()
  }

  /** Accept an incoming request: pendingIn[other] → contacts[other]. */
  acceptPendingIn(name: string): void {
    const k = normName(name)
    const ref = this.data.pendingIn[k] ?? { name, since: Date.now() }
    delete this.data.pendingIn[k]
    this.data.contacts[k] = { name: ref.name, since: Date.now() }
    this.save()
  }

  /** The other side of an accept: my outgoing request to `name` is now a contact. */
  confirmContact(name: string): void {
    const k = normName(name)
    delete this.data.pendingOut[k]
    if (!(k in this.data.contacts)) this.data.contacts[k] = { name, since: Date.now() }
    this.save()
  }

  removePendingIn(name: string): void  { delete this.data.pendingIn[normName(name)];  this.save() }
  removePendingOut(name: string): void { delete this.data.pendingOut[normName(name)]; this.save() }

  // Removing a contact also deletes the message history with them — the hub calls
  // this on BOTH sides, so the thread is gone from each party's store.
  removeContact(name: string): void {
    const k = normName(name)
    delete this.data.contacts[k]
    delete this.data.pendingIn[k]
    delete this.data.pendingOut[k]
    delete this.data.threads[k]
    this.save()
  }

  // ── messages ─────────────────────────────────────────────────────────────────
  /** Append a message to the correct thread (peer = whichever party isn't me). */
  append(msg: Message): void {
    const peer = normName(msg.from) === this.key ? normName(msg.to) : normName(msg.from)
    const thread = this.data.threads[peer] ?? (this.data.threads[peer] = [])
    thread.push({ ...msg, body: msg.body.slice(0, BODY_CAP) })
    if (thread.length > THREAD_CAP) thread.splice(0, thread.length - THREAD_CAP)
    this.save()
  }

  history(peer: string): Message[] {
    return (this.data.threads[normName(peer)] ?? []).slice()
  }

  markRead(peer: string): void {
    const thread = this.data.threads[normName(peer)]
    if (!thread) return
    let changed = false
    for (const m of thread) if (!m.read) { m.read = true; changed = true }
    if (changed) this.save()
  }

  /** Incoming messages not yet pushed to a live client — flushed on connect, then
   *  marked delivered so a later reconnect doesn't replay them. */
  takeUndelivered(): Message[] {
    const out: Message[] = []
    let changed = false
    for (const thread of Object.values(this.data.threads)) {
      for (const m of thread) {
        if (!m.delivered && normName(m.from) !== this.key) {
          m.delivered = true
          changed = true
          out.push({ ...m })
        }
      }
    }
    if (changed) this.save()
    return out.sort((a, b) => a.ts - b.ts)
  }

  // ── persistence ────────────────────────────────────────────────────────────
  private load(name: string): Persisted {
    const empty: Persisted = { self: name, contacts: {}, pendingIn: {}, pendingOut: {}, threads: {} }
    try {
      if (!existsSync(this.file)) return empty
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Persisted>
      return {
        self:       parsed.self       || name,
        contacts:   parsed.contacts   ?? {},
        pendingIn:  parsed.pendingIn  ?? {},
        pendingOut: parsed.pendingOut ?? {},
        threads:    parsed.threads    ?? {},
      }
    } catch { return empty }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
      renameSync(tmp, this.file)   // atomic publish — a reader never sees a half file
    } catch { /* best-effort; a failed write just loses this mutation */ }
  }
}

/** Ensure the messages/ directory exists under a data dir (called by the hub). */
export function ensureMessagesDir(dataDir: string): string {
  const dir = join(dataDir, 'messages')
  mkdirSync(dir, { recursive: true })
  return dir
}
