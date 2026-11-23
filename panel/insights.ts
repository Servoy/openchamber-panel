// Pure data logic: no DOM, no host. Everything here is derived from the snapshot
// and keeps the exact / estimated / not-reported distinction explicit:
// a missing input yields `null`, never 0.

import type {
  AccountUsage,
  BurnTotal,
  DailyUsage,
  SessionUsage,
  TokenCounts,
  TurnMix,
  WindowTokens,
  UsageFile
} from './schema'

export const DAY_MS = 24 * 60 * 60 * 1000
const BURN_WINDOW_MS = 7 * DAY_MS
const BURN_MIN_CREDITS = 1

// ── schema detection ─────────────────────────────────────────────────────────

/**
 * Does this snapshot carry any insight field? The signal is the `schema` marker
 * or the presence of concrete fields, never a plugin version: a plugin run from
 * source reports whatever version its package.json says.
 */
export function hasInsightFields(file: UsageFile): boolean {
  if (typeof file.schema === 'number' && file.schema >= 2) return true
  if (typeof file.sessionsTotal === 'number' || file.tools || file.daily?.length) return true
  if (file.tokens || file.burn?.some((b) => typeof b.requests === 'number')) return true
  return file.sessions.some((s) => s.tokens || s.tools || s.turns)
}

// ── burn (credits / day) ──────────────────────────────────────────────────────

/** Recent daily burn: estimated credits per day over the measured span. */
/**
 * True while burn[] covers less than its window. The plugin only counts sessions that started
 * after `meteredSince`, so for the first days after that it holds a fraction of the real work.
 * Reading it as a weekly pace would then say "almost nothing used".
 *
 * @param file the snapshot
 * @param now current time, ms epoch
 * @returns whether burn[] is still filling up
 */
export function burnIsPartial(file: UsageFile, now: number): boolean {
  if (typeof file.meteredSince !== 'number') return false
  const windowDays = file.burn?.[0]?.windowDays ?? 7
  return now - file.meteredSince < windowDays * DAY_MS
}

/**
 * Whether a session's credits were booked before per-response metering. Those were apportioned
 * from the account counter while several instances could book the same rise, so they run high.
 *
 * @param file the snapshot
 * @param s the session
 * @returns true when the session began before `meteredSince`
 */
export function isPreMetering(file: UsageFile, s: SessionUsage): boolean {
  return typeof file.meteredSince === 'number' && s.firstUsed < file.meteredSince
}

export interface Burn {
  perDay: number
  spanMs: number
  /** True when it comes from Kiro's own counter, not from apportioned or partial credits. */
  exact?: boolean
}

/** A counter span shorter than this is time-of-day noise, not a pace. */
const COUNTER_MIN_SPAN_MS = 3 * DAY_MS

/**
 * The recent burn the panel may use as a pace, best source first:
 *   1. Kiro's own counter (`counterDelta` over `counterSince` → now), exact, once it spans 3 days;
 *   2. the plugin's credits total, but only when it covers the full window: right after the
 *      metering switch it leaves out sessions that began earlier, so it is a lower bound;
 *   3. nothing, so the projection falls back to the exact month average.
 *
 * @param file the snapshot
 * @param acc the account on screen
 * @param now current time, ms epoch
 * @returns the burn to use as a pace, or null
 */
export function recentBurn(file: UsageFile, acc: AccountUsage, now: number): Burn | null {
  const total = file.burn?.find((b) => b.accountId === acc.id)
  if (total && typeof total.counterDelta === 'number' && typeof total.counterSince === 'number') {
    const spanMs = Math.min(total.windowDays * DAY_MS, now - total.counterSince)
    if (spanMs >= COUNTER_MIN_SPAN_MS && total.counterDelta >= BURN_MIN_CREDITS) {
      return { perDay: (total.counterDelta / spanMs) * DAY_MS, spanMs, exact: true }
    }
  }
  if (burnIsPartial(file, now)) return null
  return burnFor(acc, file.sessions, file.burn, now)
}

/**
 * Credits per request over sessions whose credits are fully measured: begun at or after
 * `meteredSince`. burn[] mixes credits of new sessions with requests of all sessions, so dividing
 * those would be meaningless. Needs at least 50 requests to be worth showing.
 *
 * @param file the snapshot
 * @param accountId the account on screen
 * @returns credits per request and whether it is measured, or null
 */
export function creditsPerRequest(file: UsageFile, accountId: string): { value: number; measured: boolean } | null {
  const since = file.meteredSince
  let credits = 0
  let requests = 0
  for (const s of file.sessions) {
    if (typeof since === 'number' && s.firstUsed < since) continue
    const per = s.accounts?.find((a) => a.accountId === accountId)
    credits += per ? per.estCredits : s.estCredits
    requests += per ? per.requests : s.requests
  }
  if (requests < 50) return null
  return { value: credits / requests, measured: file.creditsSource === 'metered' && typeof since === 'number' }
}

/**
 * Recent daily burn, from the plugin's per-account `burn` total when present,
 * else from the (capped) session list as a fallback for older snapshots.
 *
 * The plugin sums estimated credits over ALL sessions in a 7-day window; the
 * divisor is the measured span (floored at one day, capped at the window) so one busy hour is
 * never read as a huge daily rate. Checked on a real install: only 3% of those credits belong to
 * sessions that began before the window, so dividing by the window is the right order of size.
 */
export function burnFor(
  acc: AccountUsage,
  sessions: SessionUsage[],
  burn: BurnTotal[] | undefined,
  now: number
): Burn | null {
  const total = burn?.find((b) => b.accountId === acc.id)
  if (total) {
    if (total.credits < BURN_MIN_CREDITS) return null
    const windowMs = total.windowDays * DAY_MS
    const spanMs = Math.min(windowMs, Math.max(now - total.earliestUsed, DAY_MS))
    return { perDay: (total.credits / spanMs) * DAY_MS, spanMs }
  }

  const cutoff = now - BURN_WINDOW_MS
  let credits = 0
  let earliest = now
  for (const s of sessions) {
    const per = s.accounts?.find((a) => a.accountId === acc.id)
    const last = per?.lastUsed ?? s.lastUsed
    if (last < cutoff) continue
    credits += per ? per.estCredits : s.estCredits
    earliest = Math.min(earliest, Math.max(cutoff, per?.firstUsed ?? s.firstUsed))
  }
  if (credits < BURN_MIN_CREDITS) return null
  const spanMs = now - earliest
  return { perDay: (credits / Math.max(spanMs, DAY_MS)) * DAY_MS, spanMs }
}

// ── projections ───────────────────────────────────────────────────────────────

export interface PeriodInfo {
  startMs: number
  lenDays: number
  /** Days elapsed in the period (fractional). */
  daysUsed: number
  /** 1-based day number for display. */
  dayNo: number
  /** Always true: Kiro does not report the period start, so it is derived. */
  approx: boolean
  timePct: number
}

/** Pace per working day and what it means for the reset. */
export interface PaceView {
  perWorkday: number
  /** When the credits run out if every working day from now on looks like this. */
  runOutAt: number | null
  /** Credits left at the reset (>0) or the shortfall (<0); null without a reset date. */
  spare: number | null
}

export interface Projection {
  remaining: number
  daysToReset: number | null
  resetOverdue: boolean
  period: PeriodInfo | null
  workdaysLeft: number | null
  /** Credits left divided by working days left: what you can spend per working day. Exact inputs. */
  budgetPerWorkday: number | null
  /** Credits used this period divided by working days so far. Exact inputs. */
  periodPace: PaceView | null
  /** Estimated burn of the recent window divided by the working days it spans. */
  recentPace: PaceView | null
  /** ok: both paces make it. short: neither does. maybe: they disagree. null: not enough data. */
  verdict: 'ok' | 'maybe' | 'short' | null
}

export function periodFor(acc: AccountUsage, now: number): PeriodInfo | null {
  if (acc.resetAt == null) return null
  // Kiro reports no period start; assume a one-month period ending at the reset.
  const d = new Date(acc.resetAt)
  d.setMonth(d.getMonth() - 1)
  const startMs = d.getTime()
  const lenDays = (acc.resetAt - startMs) / DAY_MS
  if (!(lenDays > 0) || startMs > now) return null
  const daysUsed = Math.min(lenDays, (now - startMs) / DAY_MS)
  return {
    startMs,
    lenDays,
    daysUsed,
    dayNo: Math.min(Math.ceil(lenDays), Math.floor(daysUsed) + 1),
    approx: true,
    timePct: (daysUsed / lenDays) * 100
  }
}

/**
 * Fractional working days (Monday to Friday, local time) between two instants.
 * A 40-hour week: weekend days count zero, so a quiet weekend does not read as a slow pace.
 */
export function workdaysBetween(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0
  let total = 0
  const day = new Date(fromMs)
  day.setHours(0, 0, 0, 0)
  while (day.getTime() < toMs) {
    const next = new Date(day)
    next.setDate(next.getDate() + 1)
    const dow = day.getDay()
    if (dow >= 1 && dow <= 5) {
      const lo = Math.max(fromMs, day.getTime())
      const hi = Math.min(toMs, next.getTime())
      if (hi > lo) total += (hi - lo) / (next.getTime() - day.getTime())
    }
    day.setTime(next.getTime())
  }
  return total
}

/** The instant by which `workdays` more working days have passed after `fromMs`. */
export function addWorkdays(fromMs: number, workdays: number): number {
  let left = workdays
  let cursor = fromMs
  const day = new Date(fromMs)
  day.setHours(0, 0, 0, 0)
  for (let n = 0; n < 800; n++) {
    const next = new Date(day)
    next.setDate(next.getDate() + 1)
    const dow = day.getDay()
    if (dow >= 1 && dow <= 5) {
      const dayLen = next.getTime() - day.getTime()
      const start = Math.max(cursor, day.getTime())
      const avail = (next.getTime() - start) / dayLen
      if (left <= avail) return start + left * dayLen
      left -= avail
    }
    cursor = next.getTime()
    day.setTime(next.getTime())
  }
  return fromMs + workdays * DAY_MS
}

/**
 * Will the account last until the reset?
 *
 * The inputs that matter are exact: credits left, the reset date, credits used so far. They give a
 * budget per working day. The pace is then judged two ways, because a light start and a heavy
 * week can disagree and no honest single number hides that:
 *   - the period average (exact used ÷ working days so far), and
 *   - the recent burn (estimated, from the plugin) ÷ the working days it spans.
 * Both agree: say so. They disagree: say that it depends, and show both.
 */
export function projectionFor(acc: AccountUsage, burn: Burn | null, now: number): Projection {
  const remaining = Math.max(0, acc.limit - acc.used)
  const period = periodFor(acc, now)
  const daysToReset = acc.resetAt != null ? (acc.resetAt - now) / DAY_MS : null
  const resetOverdue = daysToReset != null && daysToReset <= 0
  const workdaysLeft = acc.resetAt != null && !resetOverdue ? workdaysBetween(now, acc.resetAt) : null
  const workdaysSoFar = period ? workdaysBetween(period.startMs, now) : null
  const budgetPerWorkday = workdaysLeft != null && workdaysLeft > 0 ? remaining / workdaysLeft : null

  const pace = (perWorkday: number): PaceView | null => {
    if (!(perWorkday > 0)) return null
    return {
      perWorkday,
      runOutAt: addWorkdays(now, remaining / perWorkday),
      spare: workdaysLeft != null ? remaining - perWorkday * workdaysLeft : null
    }
  }

  const periodPace = workdaysSoFar != null && workdaysSoFar >= 1 && acc.used > 0 ? pace(acc.used / workdaysSoFar) : null
  const recentDays = burn ? workdaysBetween(now - burn.spanMs, now) : 0
  const recentPace = burn && recentDays >= 1 ? pace((burn.perDay * (burn.spanMs / DAY_MS)) / recentDays) : null

  const fits = (p: PaceView | null): boolean | null => (p && p.spare != null ? p.spare >= 0 : null)
  const a = fits(periodPace)
  const b = fits(recentPace)
  let verdict: Projection['verdict'] = null
  if (a != null && b != null) verdict = a && b ? 'ok' : !a && !b ? 'short' : 'maybe'
  else if (a != null || b != null) verdict = (a ?? b) ? 'ok' : 'short'

  return { remaining, daysToReset, resetOverdue, period, workdaysLeft, budgetPerWorkday, periodPace, recentPace, verdict }
}

// ── daily trend ───────────────────────────────────────────────────────────────

export interface DayPoint {
  key: string
  ms: number
  /** null = day before the plugin started recording → "not reported". */
  credits: number | null
  requests: number | null
  toolCalls: number | null
  today: boolean
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const localDayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The last `days` local days for one account, oldest first. Days before the
 * account's first recorded day are `null` (not reported); a later day without a
 * row is a genuine zero-activity day. Returns null when there is no history.
 */
export function dailySeries(
  daily: DailyUsage[] | undefined,
  accountId: string,
  now: number,
  days: number
): DayPoint[] | null {
  const rows = (daily ?? []).filter((r) => r.accountId === accountId)
  if (!rows.length) return null
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const first = rows.reduce((m, r) => (r.day < m ? r.day : m), rows[0]!.day)
  const out: DayPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = localDayKey(d.getTime())
    const row = byDay.get(key)
    if (key < first) {
      out.push({ key, ms: d.getTime(), credits: null, requests: null, toolCalls: null, today: i === 0 })
    } else {
      out.push({
        key,
        ms: d.getTime(),
        credits: row ? row.estCredits : 0,
        requests: row ? row.requests : 0,
        toolCalls: row ? (row.toolCalls ?? null) : 0,
        today: i === 0
      })
    }
  }
  return out
}

export interface TrendStats {
  total: number
  avg: number
  /** Percent change last 7 days vs the 7 before; null unless both are measured. */
  weekDelta: number | null
}

export function trendStats(points: DayPoint[]): TrendStats | null {
  const known = points.filter((p) => p.credits != null)
  if (!known.length) return null
  const total = known.reduce((s, p) => s + (p.credits ?? 0), 0)
  let weekDelta: number | null = null
  if (points.length >= 14) {
    const last = points.slice(-7)
    const prev = points.slice(-14, -7)
    if (last.every((p) => p.credits != null) && prev.every((p) => p.credits != null)) {
      const a = last.reduce((s, p) => s + (p.credits ?? 0), 0)
      const b = prev.reduce((s, p) => s + (p.credits ?? 0), 0)
      if (b > 0) weekDelta = ((a - b) / b) * 100
    }
  }
  return { total, avg: total / known.length, weekDelta }
}

// ── tools ─────────────────────────────────────────────────────────────────────

/** Tool calls of a session: the explicit total, else the sum of its tools. */
export function toolCallsOf(s: SessionUsage): number | null {
  if (typeof s.toolCalls === 'number') return s.toolCalls
  if (s.tools) return s.tools.reduce((n, t) => n + t.count, 0)
  return null
}

export interface ToolAgg {
  name: string
  count: number
}

export interface ToolSummary {
  items: ToolAgg[]
  total: number
  /** Where the totals come from, so the UI can say how wide the window is. */
  source: 'plugin' | 'sessions'
  windowDays: number | null
  sessionCount: number | null
}

/** Tool-call totals (EXACT counts). Kiro reports no cost per tool, so none is derived. */
export function aggregateTools(file: UsageFile): ToolSummary | null {
  if (file.tools && file.tools.items.length) {
    const items = file.tools.items.map((t) => ({ name: t.name, count: t.count })).sort((a, b) => b.count - a.count)
    return { items, total: file.tools.totalCalls, source: 'plugin', windowDays: file.tools.windowDays, sessionCount: null }
  }
  const map = new Map<string, number>()
  let sessionCount = 0
  for (const s of file.sessions ?? []) {
    if (!s.tools?.length) continue
    sessionCount++
    for (const t of s.tools) map.set(t.name, (map.get(t.name) ?? 0) + t.count)
  }
  if (!map.size) return null
  const items: ToolAgg[] = [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  return { items, total: items.reduce((n, t) => n + t.count, 0), source: 'sessions', windowDays: null, sessionCount }
}

export interface ToolHit {
  session: SessionUsage
  name: string
  count: number
}

/** Session × tool pairs, most-called first. */
export function topToolHits(sessions: SessionUsage[], limit: number): ToolHit[] {
  const all: ToolHit[] = []
  for (const s of sessions) for (const t of s.tools ?? []) all.push({ session: s, name: t.name, count: t.count })
  return all.sort((a, b) => b.count - a.count).slice(0, limit)
}

// ── tokens (EXACT, from Kiro's metadataEvent.tokenUsage) ──────────────────────

/** Total prompt tokens. `inputTokens` does not exist in Kiro's TokenUsage. */
export const promptTokens = (t: TokenCounts): number =>
  t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens

export interface TokenSummary {
  counts: TokenCounts
  scope: 'window' | 'sessions'
  /** Days the totals span; only for `scope: 'window'`. */
  windowDays: number | null
  sessions: number
  /** Requests in the same scope, when known, to say "counted for N of M requests". */
  requests: number | null
  /** True when the totals cover every account, not just the one on screen. */
  allAccounts: boolean
}

/**
 * Token totals. The plugin writes one top-level block for all accounts together
 * (an OpenCode message has no account id, so per-account tokens cannot exist).
 * Without it, fall back to summing the listed sessions, which is only honest to
 * label per account when exactly one account exists.
 */
/** Accounts that appear anywhere in the file, including ones no longer signed in. */
export const accountsInUse = (file: UsageFile): number =>
  new Set([...file.accounts.map((a) => a.id), ...(file.burn ?? []).map((b) => b.accountId)]).size

export function tokenSummary(file: UsageFile, accountCount: number): TokenSummary | null {
  const t: WindowTokens | undefined = file.tokens
  if (t) {
    const { windowDays, ...counts } = t
    // `requests` stays null on purpose: the plugin's request counts cover whole sessions
    // that were active in the window, the token totals only messages inside it. They are
    // different groups, so a "counted for N of M" comparison would be wrong.
    return { counts, scope: 'window', windowDays, sessions: 0, requests: null, allAccounts: accountCount > 1 }
  }
  const acc: TokenCounts = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reportedRequests: 0 }
  let n = 0
  let reqs = 0
  for (const s of file.sessions ?? []) {
    if (!s.tokens) continue
    n++
    acc.uncachedInputTokens += s.tokens.uncachedInputTokens
    acc.outputTokens += s.tokens.outputTokens
    acc.cacheReadTokens += s.tokens.cacheReadTokens
    acc.cacheWriteTokens += s.tokens.cacheWriteTokens
    acc.reportedRequests += s.tokens.reportedRequests
    reqs += s.requests
  }
  return n ? { counts: acc, scope: 'sessions', windowDays: null, sessions: n, requests: reqs, allAccounts: accountCount > 1 } : null
}

// ── turn + output mix ─────────────────────────────────────────────────────────

export interface TurnSplit extends TurnMix {
  total: number
}

/** How the session's responses ended (EXACT). Null when the plugin did not record it. */
export function turnSplit(s: SessionUsage): TurnSplit | null {
  const t = s.turns
  if (!t) return null
  const total = t.toolUse + t.answer + t.error
  return total > 0 ? { ...t, total } : null
}

// ── sessions ──────────────────────────────────────────────────────────────────

export type SessionSort = 'cost' | 'recent' | 'requests' | 'tokens'

/** Total tokens of a session; a session without token data sorts last. */
export const sessionTokenTotal = (s: SessionUsage): number =>
  s.tokens ? promptTokens(s.tokens) + s.tokens.outputTokens : -1

export function sortSessions(list: SessionUsage[], sort: SessionSort): SessionUsage[] {
  const copy = [...list]
  switch (sort) {
    case 'cost':
      return copy.sort((a, b) => b.estCredits - a.estCredits)
    case 'requests':
      return copy.sort((a, b) => b.requests - a.requests)
    case 'tokens':
      return copy.sort((a, b) => sessionTokenTotal(b) - sessionTokenTotal(a))
    default:
      return copy.sort((a, b) => b.lastUsed - a.lastUsed)
  }
}

/** Requests the account served in the 7-day window; null when not reported. */
export function requests7d(accountId: string, burn: BurnTotal[] | undefined): number | null {
  const b = burn?.find((x) => x.accountId === accountId)
  return typeof b?.requests === 'number' ? b.requests : null
}
