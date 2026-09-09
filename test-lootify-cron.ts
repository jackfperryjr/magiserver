/* Clock arithmetic behind the daily lootify dispatch — run: npx tsx test-lootify-cron.ts
 *
 * The point of doing this in the server rather than in GitHub's cron is that 03:00
 * America/Chicago stays 03:00 across a DST transition without anyone maintaining two
 * UTC crons. That claim is only worth as much as these assertions: the interesting
 * dates are the spring-forward and fall-back Sundays, where a naive fixed-offset
 * implementation lands an hour out and nobody notices until the run drifts. */
import { generateKeyPairSync, createVerify } from 'crypto'
import { nextAfter, dayKey } from './src/lootify-cron'
import { appJwt, resolveGitHubAuth } from './src/lib/github-app'

const TZ = 'America/Chicago'
let failures = 0
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
  if (!cond) failures++
}

/** What the clock in `tz` reads at instant `t` — the assertion we actually care
 *  about, since UTC instants are unreadable at a glance. */
function localTime(t: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(t)
}
function localDate(t: number, tz: string): string { return dayKey(t, tz) }

// ── the ordinary case ──
{
  const from = Date.parse('2026-06-15T20:00:00Z')          // 15:00 CDT, well before target
  const next = nextAfter(from, TZ, 3, 0)
  check('summer: next run reads 03:00 locally', localTime(next, TZ) === '03:00')
  check('summer: next run is the following morning', localDate(next, TZ) === '2026-06-16')
  check('summer: 03:00 CDT is 08:00 UTC', new Date(next).toISOString() === '2026-06-16T08:00:00.000Z')
}

// ── winter: same local time, a different UTC instant ──
{
  const from = Date.parse('2026-01-15T20:00:00Z')
  const next = nextAfter(from, TZ, 3, 0)
  check('winter: next run reads 03:00 locally', localTime(next, TZ) === '03:00')
  check('winter: 03:00 CST is 09:00 UTC', new Date(next).toISOString() === '2026-01-16T09:00:00.000Z')
}

// ── spring forward: 2026-03-08, clocks jump 02:00 → 03:00 CST→CDT ──
// The evening before is the case a fixed offset gets wrong: it computes the target
// with the OLD offset and fires at 04:00 local. 03:00 is also the exact instant the
// clock lands on after the jump, which makes this the tightest case in the file.
{
  const eve = Date.parse('2026-03-08T04:00:00Z')           // 22:00 CST Sat 7 Mar
  const next = nextAfter(eve, TZ, 3, 0)
  check('spring forward: still 03:00 local the morning of', localTime(next, TZ) === '03:00')
  check('spring forward: lands on the transition day', localDate(next, TZ) === '2026-03-08')
  check('spring forward: shifts to 08:00 UTC', new Date(next).toISOString() === '2026-03-08T08:00:00.000Z')
}

// ── fall back: 2026-11-01, clocks repeat 01:00 CDT→CST ──
{
  const eve = Date.parse('2026-11-01T03:00:00Z')           // 22:00 CDT Sat 31 Oct
  const next = nextAfter(eve, TZ, 3, 0)
  check('fall back: still 03:00 local the morning of', localTime(next, TZ) === '03:00')
  check('fall back: lands on the transition day', localDate(next, TZ) === '2026-11-01')
  check('fall back: shifts to 09:00 UTC', new Date(next).toISOString() === '2026-11-01T09:00:00.000Z')
}

// ── "strictly after" ──
// tick() re-arms from the instant it just fired, so a target that returned itself
// would fire in a loop until the minute rolled over.
{
  const target = Date.parse('2026-06-16T08:00:00Z')        // exactly 03:00 CDT
  const next = nextAfter(target, TZ, 3, 0)
  check('exactly on target: next is tomorrow, not now', next === Date.parse('2026-06-17T08:00:00Z'))
  const justBefore = nextAfter(target - 1000, TZ, 3, 0)
  check('a second before target: next is today', justBefore === target)
}

// ── a whole year, walked ──
// Every day must be ~24h apart and read 03:00 locally; the two transition days are
// the 23h and 25h ones. Catches an off-by-one that only shows up on one date.
{
  // Seeded ON a target, not near one, so every measured gap is target-to-target —
  // otherwise the first interval is a partial day and says nothing about the rule.
  let t = nextAfter(Date.parse('2026-01-01T12:00:01Z'), TZ, 3, 0)
  let bad = 0
  const gaps: Record<number, number> = {}
  for (let i = 0; i < 365; i++) {
    const next = nextAfter(t + 1000, TZ, 3, 0)
    if (localTime(next, TZ) !== '03:00') bad++
    gaps[(next - t) / 3600_000] = (gaps[(next - t) / 3600_000] ?? 0) + 1
    t = next
  }
  check('365 consecutive runs all read 03:00 local', bad === 0)
  // Exactly two irregular days a year, one each way. Anything else — a 22h or 26h
  // gap, or a second short day — means the offset was applied on the wrong side.
  check('363 days are exactly 24h apart', gaps[24] === 363)
  check('one 23h day (spring forward)', gaps[23] === 1)
  check('one 25h day (fall back)', gaps[25] === 1)
  check('no other gap lengths occur', Object.keys(gaps).length === 3)
}

// ── dayKey is the local date, not the UTC one ──
// The dedupe marker has to roll over at local midnight; a UTC date would make the
// 18:00-CST-onwards window look like "tomorrow" and permit a second dispatch.
{
  const lateEvening = Date.parse('2026-01-16T04:30:00Z')   // 22:30 CST on the 15th
  check('dayKey uses local date across the UTC rollover', dayKey(lateEvening, TZ) === '2026-01-15')
}

// ── GitHub App JWT (the self-rotating credential) ──
// The whole reason to prefer App auth over a PAT is that the token on the wire is
// minted fresh and expires hourly. That only holds if the JWT we present is actually
// well-formed and correctly signed, so assert it against a throwaway keypair rather
// than discovering a base64url slip as a 401 in production.
{
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const jwt = appJwt('123456', pem)
  const [h, p, s] = jwt.split('.')
  check('JWT has three segments', !!h && !!p && !!s)

  const header  = JSON.parse(Buffer.from(h ?? '', 'base64url').toString()) as { alg: string; typ: string }
  const payload = JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as { iat: number; exp: number; iss: string }
  check('JWT header declares RS256', header.alg === 'RS256' && header.typ === 'JWT')
  check('JWT issuer is the app id', payload.iss === '123456')
  // GitHub rejects anything over 10 minutes, and a JWT issued in its future.
  check('JWT lifetime is within GitHub’s 10-minute cap', payload.exp - payload.iat <= 600)
  check('JWT iat is backdated for clock skew', payload.iat < Math.floor(Date.now() / 1000))

  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${h}.${p}`)
  verifier.end()
  check('JWT signature verifies against the public key',
    verifier.verify(publicKey, Buffer.from(s ?? '', 'base64url')))

  // GitHub hands you PKCS#1 (`BEGIN RSA PRIVATE KEY`), not the PKCS#8 above, so that
  // is the format that actually has to work — and the armor lines are load-bearing:
  // strip them and there is nothing telling the parser which of the two it holds.
  const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  check('the downloaded key is PKCS#1', pkcs1.startsWith('-----BEGIN RSA PRIVATE KEY-----'))
  const [h1, p1, s1] = appJwt('123456', pkcs1).split('.')
  const v1 = createVerify('RSA-SHA256')
  v1.update(`${h1}.${p1}`)
  v1.end()
  check('PKCS#1 key signs a verifiable JWT', v1.verify(publicKey, Buffer.from(s1 ?? '', 'base64url')))

  // A PEM that has been through a Windows clipboard arrives CRLF-terminated.
  const [h2, p2, s2] = appJwt('123456', pkcs1.replace(/\n/g, '\r\n')).split('.')
  const v2 = createVerify('RSA-SHA256')
  v2.update(`${h2}.${p2}`)
  v2.end()
  check('CRLF line endings still sign', v2.verify(publicKey, Buffer.from(s2 ?? '', 'base64url')))
}

// ── credential selection ──
// App must win when both are present, or setting up the App would silently leave the
// expiring PAT in charge — the exact failure this design exists to avoid.
{
  const saved = { ...process.env }
  process.env['MAGILOOM_GITHUB_TOKEN'] = 'ghp_fake'
  delete process.env['MAGILOOM_GITHUB_APP_ID']
  delete process.env['MAGILOOM_GITHUB_APP_KEY']
  check('PAT alone yields pat auth', resolveGitHubAuth('o/r')?.kind === 'pat')

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  process.env['MAGILOOM_GITHUB_APP_ID'] = '1'
  process.env['MAGILOOM_GITHUB_APP_KEY'] = pem
  check('App wins when both are configured', resolveGitHubAuth('o/r')?.kind === 'app')
  // Railway env vars mangle multi-line PEMs often enough that base64 is accepted too.
  process.env['MAGILOOM_GITHUB_APP_KEY'] = Buffer.from(pem).toString('base64')
  check('base64-wrapped private key is accepted', resolveGitHubAuth('o/r')?.kind === 'app')

  delete process.env['MAGILOOM_GITHUB_APP_ID']
  delete process.env['MAGILOOM_GITHUB_APP_KEY']
  delete process.env['MAGILOOM_GITHUB_TOKEN']
  check('no credential yields null (feature stays off)', resolveGitHubAuth('o/r') === null)
  process.env = saved
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
