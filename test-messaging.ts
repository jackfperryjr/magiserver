/* Ad-hoc e2e for the Magiloom messaging hub — run: npx tsx test-messaging.ts
 * Drives MessageHub directly with mock sessions (the messaging logic is independent
 * of the game socket), covering: presence, contact requests + accept, mutual
 * auto-accept, online delivery, offline queue + flush on connect, non-contact
 * rejection, presence broadcast to contacts, and on-disk persistence. */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MessageHub, type Deliverable } from './src/message-hub'
import { MessageStore } from './src/lib/message-store'

let failures = 0
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
  if (!cond) failures++
}

interface Ev { channel: string; args: unknown[] }
class MockSession implements Deliverable {
  events: Ev[] = []
  deliver(channel: string, ...args: unknown[]): void { this.events.push({ channel, args }) }
  drain(channel: string): Ev[] {
    const got = this.events.filter(e => e.channel === channel)
    this.events = this.events.filter(e => e.channel !== channel)
    return got
  }
}

const dir = mkdtempSync(join(tmpdir(), 'magiloom-msg-'))
try {
  const hub = new MessageHub(dir)
  const alice = new MockSession()
  const bob   = new MockSession()

  // ── presence ──
  hub.register('Alice', alice)
  hub.register('Bob', bob)
  check('both online after register', hub.isOnline('alice') && hub.isOnline('BOB'))

  // ── contact request + accept ──
  const req = hub.requestContact('Alice', 'Bob')
  check('request ok, not auto-accepted', req.ok && !req.autoAccepted)
  check('Bob got contacts:request from Alice',
    bob.drain('contacts:request').some(e => (e.args[0] as { name: string }).name === 'Alice'))
  check('Alice sees pendingOut Bob', hub.contacts('Alice').pendingOut.some(c => c.name === 'Bob'))
  check('Bob sees pendingIn Alice',  hub.contacts('Bob').pendingIn.some(c => c.name === 'Alice'))
  check('cannot message before accept', !hub.send('Alice', 'Bob', 'hi').ok)

  const acc = hub.acceptContact('Bob', 'Alice')
  check('accept ok', acc.ok)
  const aBook = hub.contacts('Alice'), bBook = hub.contacts('Bob')
  check('Alice now has contact Bob', aBook.contacts.some(c => c.name === 'Bob'))
  check('Bob now has contact Alice', bBook.contacts.some(c => c.name === 'Alice'))
  check('Alice presence map shows Bob online', aBook.presence['bob'] === true)
  check('both notified contacts:added',
    alice.drain('contacts:added').length > 0 && bob.drain('contacts:added').length > 0)

  // ── online delivery ──
  alice.events = []; bob.events = []
  const sent = hub.send('Alice', 'Bob', 'hey Bob')
  check('send ok, returns authored message', sent.ok && sent.message?.body === 'hey Bob')
  const bobRx = bob.drain('msg:received')
  check('Bob received the message live', bobRx.length === 1 && (bobRx[0].args[0] as { body: string }).body === 'hey Bob')
  check('sender copy mirrored to Alice (dedupe by id)',
    alice.drain('msg:received').some(e => (e.args[0] as { id: string }).id === sent.message!.id))
  check('history holds one message each',
    hub.history('Alice', 'Bob').length === 1 && hub.history('Bob', 'Alice').length === 1)

  // ── non-contact rejection ──
  check('cannot message a stranger', !hub.send('Alice', 'Carol', 'psst').ok)

  // ── offline queue + flush on connect ──
  hub.deregister('Bob', bob)
  check('Bob offline after deregister', !hub.isOnline('Bob'))
  check('Alice told Bob went offline',
    alice.drain('contacts:presence').some(e => {
      const p = e.args[0] as { name: string; online: boolean }
      return p.name === 'Bob' && p.online === false
    }))
  const offline = hub.send('Alice', 'Bob', 'you there?')
  check('send to offline contact still ok (queued)', offline.ok)
  const bob2 = new MockSession()
  hub.register('Bob', bob2)   // Bob reconnects (possibly a different device)
  const flushed = bob2.drain('msg:received')
  check('queued message flushed to Bob on reconnect',
    flushed.length === 1 && (flushed[0].args[0] as { body: string }).body === 'you there?')
  check('Alice told Bob came back online',
    alice.drain('contacts:presence').some(e => (e.args[0] as { online: boolean }).online === true))
  hub.register('Bob', bob2)   // idempotent re-register must not re-flush
  check('re-register does not replay delivered messages', bob2.drain('msg:received').length === 0)

  // ── mutual request auto-accept ──
  const carol = new MockSession(), dave = new MockSession()
  hub.register('Carol', carol); hub.register('Dave', dave)
  hub.requestContact('Carol', 'Dave')
  const mutual = hub.requestContact('Dave', 'Carol')   // Dave asks back
  check('mutual request auto-accepts', mutual.ok && mutual.autoAccepted === true)
  check('Carol & Dave are now contacts',
    hub.contacts('Carol').contacts.some(c => c.name === 'Dave') &&
    hub.contacts('Dave').contacts.some(c => c.name === 'Carol'))

  // ── remove contact ──
  hub.removeContact('Alice', 'Bob')
  check('contact removed both sides',
    !hub.contacts('Alice').contacts.some(c => c.name === 'Bob') &&
    !hub.contacts('Bob').contacts.some(c => c.name === 'Alice'))
  check('cannot message after removal', !hub.send('Alice', 'Bob', 'still there?').ok)

  // ── persistence: a fresh store reads what the hub wrote ──
  const carolDisk = new MessageStore(join(dir, 'messages'), 'Carol')
  check('Carol contacts persisted to disk', carolDisk.isContact('Dave'))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
