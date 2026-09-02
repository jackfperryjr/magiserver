import type { AccountTier } from '../accounts'

// ── Storage limits by plan ──────────────────────────────────────────────────────
// Log retention is what the free/paid split actually rations. It's the right thing
// to ration because it's the only per-user cost that grows without bound, so the
// volume bill tracks paying users instead of running ahead of them.
//
// Each tier carries TWO numbers, and the byte ceiling — not the day count — is the
// real guarantee. Days are what a person can reason about, but they don't bound
// bytes: measured on a real install, play averaged ~32 MB per active day with an
// 83 MB peak, and a character left writing Lich's flattened `.log` (a per-character
// setting in Lich's own YAML, which this server cannot control) roughly triples it.
// So "3 days" could mean 60 MB or 400 MB depending on who is playing. The ceiling
// is what makes the free tier a promise rather than a hope.
//
// READING logs is deliberately NOT rationed — every tier can view and download
// everything it still holds. Rationing how long we keep someone's data is a fair
// line; charging them to read their own data back is not.

export interface TierLimits {
  /** Maximum retention in days this plan may request. */
  maxDays: number
  /** Total bytes of logs (Lich's AND Lantern's, combined) kept per user. */
  maxBytes: number
  /** Default when the user hasn't chosen. */
  defaultDays: number
  /** Day choices the client offers for this plan. */
  choices: number[]
}

export const TIERS: Record<AccountTier, TierLimits> = {
  free: { maxDays: 3,  defaultDays: 3,  maxBytes: 100 * 1024 * 1024,  choices: [1, 3] },
  paid: { maxDays: 14, defaultDays: 7,  maxBytes: 1024 * 1024 * 1024, choices: [3, 7, 14] },
}

/**
 * Grace after a DOWNGRADE. Dropping from paid to free takes retention 14 → 3 days,
 * so the very next prune would delete eleven days of someone's logs — a billing
 * event silently destroying data. For this long after the change the OLD, more
 * generous limits still apply, which gives the user a window to download anything
 * they want to keep. Surfaced to the client (see graceRemainingMs) so it can say so
 * rather than leaving them to discover it.
 */
export const DOWNGRADE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export interface TierState {
  tier: AccountTier
  /** Previous plan, when a change is still inside its grace window. */
  prevTier?: AccountTier
  /** When the plan last changed. */
  tierChangedAt?: number
}

/** Milliseconds of downgrade grace left, or 0 when none applies. */
export function graceRemainingMs(state: TierState, now = Date.now()): number {
  // Only a downgrade earns grace — an upgrade takes effect at once, and there is
  // nothing to protect when limits are getting larger.
  if (!state.prevTier || !state.tierChangedAt) return 0
  if (!isDowngrade(state.prevTier, state.tier)) return 0
  return Math.max(0, state.tierChangedAt + DOWNGRADE_GRACE_MS - now)
}

function isDowngrade(from: AccountTier, to: AccountTier): boolean {
  return TIERS[from].maxBytes > TIERS[to].maxBytes
}

/**
 * The limits actually in force for an account, honouring downgrade grace.
 * Everything that prunes or clamps must go through this rather than reading TIERS
 * directly, so the grace window can't be bypassed by one code path forgetting it.
 */
export function effectiveLimits(state: TierState, now = Date.now()): TierLimits {
  return graceRemainingMs(state, now) > 0 && state.prevTier
    ? TIERS[state.prevTier]
    : TIERS[state.tier]
}

/**
 * Resolve a requested retention against a plan. The client's stored setting is a
 * REQUEST, never an authority: it's clamped here, server-side, so a patched
 * settings.json can't buy retention the account hasn't paid for.
 */
export function resolveRetentionDays(state: TierState, requested: unknown, now = Date.now()): number {
  const limits = effectiveLimits(state, now)
  const n = Math.floor(Number(requested))
  if (!Number.isFinite(n) || n <= 0) return Math.min(limits.defaultDays, limits.maxDays)
  return Math.min(n, limits.maxDays)
}

/** What the client needs to render its retention control and warnings honestly. */
export interface TierInfo {
  tier: AccountTier
  maxDays: number
  maxBytes: number
  choices: number[]
  effectiveDays: number
  /** >0 while a downgrade's old limits are still being honoured. */
  graceMs: number
  prevTier?: AccountTier
}
