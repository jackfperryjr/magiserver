import { randomUUID } from 'crypto'
import {
  MessageStore, ensureMessagesDir, normName,
  type Message, type ContactBook,
} from './lib/message-store'

// ── Magiloom messaging hub (server-global) ───────────────────────────────────────
// The in-memory half of the messaging system: it holds live PRESENCE (which
// character names have a session attached right now) and ROUTES messages and
// contact events between characters. Durable state (contacts, threads, offline
// inbox) lives in per-character JSON via MessageStore.
//
// One hub for the whole server (a singleton in ServerContext, like the shared map).
// Presence is in-memory, which is correct for the single-instance Railway deploy;
// if the server is ever scaled horizontally this is the piece that would move to a
// shared bus (Redis/Postgres LISTEN) — the durable store already is shared on disk.
//
// This is deliberately SEPARATE from in-game speech (the Conversations panel, routed
// from the game stream). Nothing here touches the DR game socket.

/** Anything the hub can push events to — implemented by Session (its `deliver`
 *  broadcasts to every client/device attached to that character's session). Kept
 *  as a structural interface so the hub doesn't depend on Session (and is trivially
 *  testable with a mock). */
export interface Deliverable {
  deliver(channel: string, ...args: unknown[]): void
  /** Optionally web-push an incoming message to this character's devices when their
   *  app is closed (implemented by Session; absent on test doubles). */
  maybePushMessage?(fromName: string, body: string): void
}

export interface Result { ok: boolean; error?: string }

export class MessageHub {
  private readonly dir: string
  private readonly stores = new Map<string, MessageStore>()   // normName → store
  private readonly online = new Map<string, Set<Deliverable>>() // normName → live sessions

  constructor(dataDir: string) {
    this.dir = ensureMessagesDir(dataDir)
  }

  private store(name: string): MessageStore {
    const key = normName(name)
    let s = this.stores.get(key)
    if (!s) { s = new MessageStore(this.dir, name); this.stores.set(key, s) }
    return s
  }

  isOnline(name: string): boolean {
    const set = this.online.get(normName(name))
    return !!set && set.size > 0
  }

  // ── presence ─────────────────────────────────────────────────────────────────
  /** A character's session came online (game socket up). Flushes its offline inbox
   *  to that session and announces the character to its online contacts. Idempotent
   *  per (name, session). */
  register(name: string, session: Deliverable): void {
    const key = normName(name)
    if (!key) return
    const store = this.store(name)
    store.setSelf(name)
    let set = this.online.get(key)
    if (!set) { set = new Set(); this.online.set(key, set) }
    const wasOffline = set.size === 0
    set.add(session)
    // Deliver anything that arrived while this character was offline — to THIS session
    // only (a reconnect of one of several devices shouldn't replay to the others).
    for (const m of store.takeUndelivered()) session.deliver('msg:received', m)
    if (wasOffline) this.broadcastPresence(name, true)
  }

  /** A session detached. The character goes offline (and its contacts are told) only
   *  once its LAST session is gone. */
  deregister(name: string, session: Deliverable): void {
    const key = normName(name)
    const set = this.online.get(key)
    if (!set) return
    set.delete(session)
    if (set.size === 0) { this.online.delete(key); this.broadcastPresence(name, false) }
  }

  private broadcastPresence(name: string, online: boolean): void {
    const display = this.store(name).self()
    for (const c of this.store(name).contacts().contacts) {
      this.emitTo(c.name, 'contacts:presence', { name: display, online })
    }
  }

  private emitTo(name: string, channel: string, ...args: unknown[]): void {
    const set = this.online.get(normName(name))
    if (set) for (const s of set) s.deliver(channel, ...args)
  }

  // ── contacts ─────────────────────────────────────────────────────────────────
  /** This character's contact book, annotated with each contact's live presence. */
  contacts(self: string): ContactBook & { presence: Record<string, boolean> } {
    const book = this.store(self).contacts()
    const presence: Record<string, boolean> = {}
    for (const c of book.contacts) presence[normName(c.name)] = this.isOnline(c.name)
    return { ...book, presence }
  }

  /** Send a contact request. If the target has already requested us, it auto-accepts
   *  (a mutual request needs no second click). */
  requestContact(self: string, other: string): Result & { autoAccepted?: boolean } {
    const sk = normName(self), ok = normName(other)
    if (!ok)       return { ok: false, error: 'Enter a character name.' }
    if (ok === sk) return { ok: false, error: "You can't add yourself." }
    const me = this.store(self)
    if (me.isContact(other))   return { ok: false, error: 'Already a contact.' }
    if (me.hasPendingIn(other)) { this.acceptContact(self, other); return { ok: true, autoAccepted: true } }
    me.addPendingOut(other)
    this.store(other).addPendingIn(self)
    this.emitTo(other, 'contacts:request', { name: me.self() })
    return { ok: true }
  }

  /** Accept an incoming request (or confirm an already-linked pair). Links both
   *  sides and notifies each of the other, with current presence. */
  acceptContact(self: string, other: string): Result {
    const me = this.store(self)
    if (!me.hasPendingIn(other) && !me.isContact(other)) {
      return { ok: false, error: 'No pending request from that character.' }
    }
    me.acceptPendingIn(other)
    this.store(other).confirmContact(self)
    this.emitTo(other, 'contacts:added', { name: me.self(),               online: this.isOnline(self) })
    this.emitTo(self,  'contacts:added', { name: this.store(other).self(), online: this.isOnline(other) })
    return { ok: true }
  }

  /** Decline (or cancel) a pending request in either direction. */
  denyContact(self: string, other: string): Result {
    this.store(self).removePendingIn(other)
    this.store(self).removePendingOut(other)
    this.store(other).removePendingOut(self)
    this.store(other).removePendingIn(self)
    return { ok: true }
  }

  /** Remove a contact on both sides and tell the other party. */
  removeContact(self: string, other: string): Result {
    const display = this.store(self).self()
    this.store(self).removeContact(other)
    this.store(other).removeContact(self)
    this.emitTo(other, 'contacts:removed', { name: display })
    return { ok: true }
  }

  // ── messaging ──────────────────────────────────────────────────────────────────
  history(self: string, peer: string): Message[] { return this.store(self).history(peer) }
  markRead(self: string, peer: string): void      { this.store(self).markRead(peer) }

  /** Send a message to a contact. Delivered live if the recipient is online; otherwise
   *  stored undelivered and flushed to them on their next connect. Both parties keep a
   *  copy. Also mirrored to the sender's OTHER devices so they stay in sync. */
  send(self: string, peer: string, body: string): Result & { message?: Message } {
    const text = (body ?? '').trim()
    if (!text) return { ok: false, error: 'Empty message.' }
    const me = this.store(self)
    if (!me.isContact(peer)) return { ok: false, error: 'You can only message a contact.' }

    const peerStore = this.store(peer)
    const online = this.isOnline(peer)
    const base: Message = {
      id:        randomUUID(),
      from:      me.self(),
      to:        peerStore.self(),
      body:      text.slice(0, 4000),
      ts:        Date.now(),
      read:      false,
      delivered: false,
    }
    // Author's own copy is always read + delivered.
    const authored: Message = { ...base, read: true, delivered: true }
    me.append(authored)
    // Recipient's copy: delivered now iff they're online to receive the live event.
    peerStore.append({ ...base, read: false, delivered: online })

    if (online) {
      // Deliver live to each of the recipient's sessions, and let each decide whether
      // to web-push (only when that session has no live client — i.e. the app is shut).
      const set = this.online.get(normName(peer))
      if (set) for (const s of set) {
        s.deliver('msg:received', base)
        s.maybePushMessage?.(base.from, base.body)
      }
    }
    // Mirror to the sender's other devices (the originating client also gets the
    // return value; clients dedupe by message id). No push to the sender.
    this.emitTo(self, 'msg:received', authored)
    return { ok: true, message: authored }
  }
}
