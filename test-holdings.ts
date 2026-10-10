/* Ad-hoc e2e for the account inventory — run: npx tsx test-holdings.ts
 * Drives the per-user HoldingsStore the way sessions do, covering: one store per
 * Magiloom account shared by all its sessions, isolation between accounts, a report
 * filed by one session reaching the others, replace-not-merge, the family vault
 * living on the game account, input cleaning, and on-disk persistence. */
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { UserRegistry } from './src/user-context'
import type { HoldingsDoc } from './src/lib/holdings-store'

let failures = 0
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
  if (!cond) failures++
}

const dir = mkdtempSync(join(tmpdir(), 'magiloom-holdings-'))
try {
  const users = new UserRegistry(dir)

  // Two sessions of one Magiloom account (two characters, or phone + desktop).
  const a1 = users.get('jack@example.com').holdings
  const a2 = users.get('Jack@Example.com').holdings
  check('one account, one store, whatever the case of the id', a1 === a2)

  // What a session does: forward every change to its client.
  const seenBySecond: HoldingsDoc[] = []
  a2.on('changed', (doc: HoldingsDoc) => seenBySecond.push(doc))

  const doc = a1.put({ account: 'JACKP', character: 'Refia', kind: 'inv',
    items: [{ name: 'a rugged brown backpack', depth: 0 }, { name: 'a vial of ithor potion', depth: 1 }] })
  check('put returns the whole document', doc.accounts['jackp'].characters['refia'].inv?.items.length === 2)
  check('the other session is told', seenBySecond.length === 1
    && seenBySecond[0].accounts['jackp'].characters['refia'].inv?.items[1].name === 'a vial of ithor potion')
  check('the server stamps the time', Math.abs((doc.accounts['jackp'].characters['refia'].inv?.at ?? 0) - Date.now()) < 5000)

  a2.put({ account: 'JACKP', character: 'Penello', kind: 'vault', items: [{ name: 'a rockwood bo staff', depth: 0 }] })
  a2.put({ account: 'JACKP', character: 'Penello', kind: 'family', items: [{ name: 'an ironwood chest', depth: 0 }] })
  const both = a1.get().accounts['jackp']
  check('a second character sits beside the first', Object.keys(both.characters).sort().join() === 'penello,refia')
  check('the family vault is the game account\'s, not a character\'s', both.family?.items[0].name === 'an ironwood chest' && both.family?.by === 'Penello')

  a1.put({ account: 'JACKP', character: 'Refia', kind: 'inv', items: [{ name: 'a hat', depth: 0 }] })
  check('running a report again replaces it', a1.get().accounts['jackp'].characters['refia'].inv?.items.map(i => i.name).join() === 'a hat')

  // Another Magiloom account sees none of it.
  const b = users.get('someone-else@example.com').holdings
  check('accounts are isolated', Object.keys(b.get().accounts).length === 0)
  b.put({ account: 'JACKP', character: 'Refia', kind: 'inv', items: [{ name: 'a decoy', depth: 0 }] })
  check('and cannot write into each other', a1.get().accounts['jackp'].characters['refia'].inv?.items[0].name === 'a hat')

  // Nothing a client sends is trusted.
  a1.put({ account: 'JACKP', character: 'Refia', kind: 'inv', items: [
    { name: ' a wand ', depth: 3.6 }, { name: '', depth: 0 }, { name: 'x'.repeat(5000), depth: 99 }, 7, null,
  ] as never })
  const cleaned = a1.get().accounts['jackp'].characters['refia'].inv!.items
  check('items are cleaned', cleaned.length === 2 && cleaned[0].name === 'a wand' && cleaned[0].depth === 4)
  check('long names and wild depths are bounded', cleaned[1].name.length === 240 && cleaned[1].depth === 16)
  let refused = 0
  for (const bad of [
    { account: 'JACKP', character: '', kind: 'inv', items: [] },
    { account: 'JACKP', character: 'Refia', kind: 'bank', items: [] },
  ]) { try { a1.put(bad as never) } catch { refused++ } }
  check('a report with no character, or of an unknown kind, is refused', refused === 2)

  a1.remove('JACKP', 'Penello')
  check('a character can be forgotten', a1.get().accounts['jackp'].characters['penello'] === undefined)

  // Persistence: a fresh registry (a server restart) reads the same file back.
  check('written under the user\'s own directory', existsSync(join(dir, 'users', 'jack_example.com', 'holdings.json')))
  const again = new UserRegistry(dir).get('jack@example.com').holdings.get()
  check('survives a restart', again.accounts['jackp'].characters['refia'].inv?.items[0].name === 'a wand'
    && again.accounts['jackp'].family?.items[0].name === 'an ironwood chest')
  users.dispose()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
