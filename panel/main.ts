import { connectHost, HostRequestError } from '@openchamber/sdk'
import { applyHostReady, mountBanner, mountEmpty } from '@openchamber/sdk/ui'

/**
 * Where the plugin may have written kiro-usage.json, tried in order.
 *
 * The plugin writes to OpenCode's own config dir, which differs per OS:
 * `~/.config/opencode` on macOS/Linux, `%APPDATA%\opencode` on Windows. The
 * panel cannot read env vars, so it probes both defaults and uses the first
 * that exists. Each must also be a declared `contributes.filesystem` pattern
 * in package.json, or readFile is refused before it reaches disk.
 */
const USAGE_FILES = [
  '~/.config/opencode/kiro-usage.json',
  '~/AppData/Roaming/opencode/kiro-usage.json'
]
const POLL_MS = 10_000
// Beyond this the snapshot is treated as stale — the plugin syncs at most once a
// minute and only after a request, so this flags "no fresh reading lately".
const STALE_MS = 90_000

/** One account, as the plugin's kiro-usage.json writes it. */
interface AccountUsage {
  id: string
  email: string
  region: string
  used: number
  limit: number
  pct: number
  plan?: string
  planType?: string
  overageStatus?: string
  overageRate?: number
  overageCap?: number
  currentOverages?: number
  unit?: string
  resetAt?: number
  daysUntilReset?: number
  isHealthy: boolean
  updatedAt: number
}

/** One account's contribution to a session, as the plugin writes it. */
interface SessionAccountUsage {
  accountId: string
  requests: number
  estCredits: number
  firstUsed: number
  lastUsed: number
}

interface SessionUsage {
  sessionId: string
  title?: string
  directory?: string
  requests: number
  estCredits: number
  firstUsed: number
  lastUsed: number
  /** Per-account split behind the totals; present when a session spans accounts. */
  accounts?: SessionAccountUsage[]
}

interface PluginInstance {
  pid: number
  version: string
  source?: string
  self: boolean
  lastSeen: number
}

interface UsageFile {
  version: 1
  writtenAt: number
  pluginVersion?: string
  pluginInstances?: PluginInstance[]
  accounts: AccountUsage[]
  sessions: SessionUsage[]
}

/** The plugin version that first writes the usage snapshot. */
const MIN_SUPPORTED_VERSION = '2.2.0'

const PLUGIN_PKG = '@servoy/opencode-kiro-auth'
const VERSION_CHECK_MS = 60 * 60 * 1000

const host = connectHost()
const root = document.querySelector('#root') as HTMLElement

let mounted: Array<{ dispose: () => void }> = []
const clear = () => {
  for (const block of mounted) block.dispose()
  mounted = []
  root.innerHTML = ''
}

// The current OpenChamber session id, to highlight its row in the session list.
let currentSessionId: string | null = null
// Last known reset time per account, ms. A fresh snapshot can omit resetAt
// (some getUsageLimits param combos drop it), which would make the ETA row
// flicker away on a repaint; remembering it keeps the ETA stable.
const lastResetAt = new Map<string, number>()
// The active session's title from the host, used to name its row when the
// plugin has not recorded a title yet (a brand-new session shows only its id).
let currentSessionTitle: string | null = null
// Which account the pager is showing; kept across repaints so a poll does not
// reset the user back to the first account.
let accountIdx = 0

// ── persisted UI state ────────────────────────────────────────────────────────

/**
 * Session titles seen via the host, persisted across reloads.
 *
 * The host only tells the panel the title of the *current* session
 * (`onSession`); a session drops out of that once you switch away, and a
 * plain in-memory `Map` forgets it again on the next reload or OpenChamber
 * restart. `host.storage` survives both — it is server-side, per-extension
 * storage, and needs no extra capability.
 */
const SESSION_TITLES_KEY = 'session-titles'
/** Trim to this many entries on save, so the stored value stays well under
 * the 64 KiB-per-key limit regardless of how long the panel has run. */
const SESSION_TITLES_MAX = 300
const sessionTitleCache = new Map<string, { title: string; seenAt: number }>()
let sessionTitlesLoaded = false
let saveTitlesTimer: ReturnType<typeof setTimeout> | undefined

/** Whether the account "Details" section is expanded; persisted, default off. */
const DETAILS_OPEN_KEY = 'details-open'
let detailsOpen = false

async function loadUiState(): Promise<void> {
  try {
    const [titles, open] = await Promise.all([
      host.storage.get(SESSION_TITLES_KEY),
      host.storage.get(DETAILS_OPEN_KEY)
    ])
    if (titles && typeof titles === 'object') {
      for (const [id, entry] of Object.entries(titles as Record<string, unknown>)) {
        const e = entry as { title?: unknown; seenAt?: unknown }
        if (typeof e?.title !== 'string' || typeof e?.seenAt !== 'number') continue
        // onSession can fire (and populate the cache) before this load
        // resolves; never let a stored entry overwrite a fresher live one.
        const existing = sessionTitleCache.get(id)
        if (!existing || existing.seenAt < e.seenAt) {
          sessionTitleCache.set(id, { title: e.title, seenAt: e.seenAt })
        }
      }
    }
    if (typeof open === 'boolean') detailsOpen = open
  } catch {
    // No stored state yet, or storage unavailable — start with defaults.
  } finally {
    sessionTitlesLoaded = true
    void paint(true)
  }
}

function scheduleSaveSessionTitles(): void {
  if (saveTitlesTimer) clearTimeout(saveTitlesTimer)
  // Debounced: switching sessions repeatedly should not write on every switch.
  // Also wait for the initial load: writing before it lands would let that
  // load's merge (which only adds, never removes) clobber a just-renamed
  // entry with a stale one loaded from storage.
  saveTitlesTimer = setTimeout(() => {
    if (!sessionTitlesLoaded) {
      scheduleSaveSessionTitles()
      return
    }
    // Keep only the most recently seen entries so the stored value cannot
    // grow without bound over months of use.
    const trimmed = [...sessionTitleCache.entries()]
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, SESSION_TITLES_MAX)
    void host.storage.set(SESSION_TITLES_KEY, Object.fromEntries(trimmed)).catch(() => {})
  }, 1500)
}

/** Remember a real (non-id) session title and persist it, debounced. */
function rememberSessionTitle(sessionId: string, title: string, now: number): void {
  const existing = sessionTitleCache.get(sessionId)
  if (existing?.title === title) {
    existing.seenAt = now
    return
  }
  sessionTitleCache.set(sessionId, { title, seenAt: now })
  scheduleSaveSessionTitles()
}

// The latest published plugin version, fetched from npm at most hourly.
let latestVersion: string | null = null
let latestVersionCheckedAt = 0

/**
 * Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 *
 * Pre-release tags are ignored (compared on the numeric core only) — the panel
 * only needs "is the install behind the published release", not full semver
 * precedence.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * Fetch the latest published version from npm, at most once an hour.
 *
 * Goes through the declared npm integration so the sandbox rule is satisfied;
 * the registry is public, so a missing/dummy token still answers 200. Any
 * failure (offline, DISCONNECTED, rate limit) leaves `latestVersion` as-is and
 * the panel simply shows the installed version without a comparison.
 */
/**
 * Fetch the latest npm version, at most once an hour. Returns whether
 * `latestVersion` actually changed, so a background caller only repaints when
 * there is something new to show (and never loops: an unchanged result, or the
 * hourly-cached early return, reports false).
 */
async function refreshLatestVersion(now: number): Promise<boolean> {
  if (latestVersionCheckedAt > 0 && now - latestVersionCheckedAt < VERSION_CHECK_MS) return false
  latestVersionCheckedAt = now
  const before = latestVersion
  try {
    const result = await host.request({
      method: 'GET',
      path: `/${encodeURIComponent(PLUGIN_PKG)}/latest`
    })
    if (result.status === 200) {
      const data = JSON.parse(result.body) as { version?: string }
      if (data.version) latestVersion = data.version
    }
  } catch {
    // Offline or not connected — keep whatever we had, no warning noise.
  }
  return latestVersion !== before
}

// ── small DOM + formatting helpers ────────────────────────────────────────────

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** A stroked line-icon (Feather-style), sized in em so it scales with text. */
function icon(paths: string, size = 0.85): SVGElement {
  const svg = svgEl('svg', {
    width: `${size}em`,
    height: `${size}em`,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2.4,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'ico'
  })
  for (const d of paths.split('|')) {
    if (d.startsWith('circle:')) {
      const [cx, cy, r] = d.slice(7).split(',')
      svg.appendChild(svgEl('circle', { cx: cx!, cy: cy!, r: r! }))
    } else {
      svg.appendChild(svgEl('path', { d }))
    }
  }
  return svg
}
const ICON_BOLT = 'M13 2 3 14h7l-1 8 10-12h-7z'
const ICON_CLOCK = 'circle:12,12,9|M12 7v5l3 2'
const ICON_CHEVRON_DOWN = 'M6 9l6 6 6-6'
const ICON_CHEVRON_LEFT = 'M15 18l-6-6 6-6'
const ICON_CHEVRON_RIGHT = 'M9 18l6-6-6-6'
const ICON_INFO = 'circle:12,12,10|M12 16v-4|M12 8h.01'

/**
 * An ⓘ icon carrying an explanation as a native tooltip.
 *
 * Uses title= (works inside the sandbox with no extra markup or focus trap),
 * plus aria-label and tabindex so it is reachable by keyboard and screen reader.
 */
/**
 * An ⓘ that reveals its explanation in a CSS tooltip.
 *
 * Native title= is unreliable in the sandboxed iframe (the host suppresses it
 * or it draws outside the visible panel), so this wraps the icon and shows the
 * text from an own element on hover/focus. It positions above the icon and
 * clamps to the panel width so it never forces a horizontal scroll.
 */
function infoIcon(text: string): HTMLElement {
  const wrap = el('span', 'info-wrap')
  wrap.setAttribute('tabindex', '0')
  wrap.setAttribute('role', 'img')
  wrap.setAttribute('aria-label', text)
  const ico = icon(ICON_INFO, 0.85)
  ico.classList.add('info-ico')
  wrap.appendChild(ico)
  const tip = el('span', 'tip', text)
  wrap.appendChild(tip)
  // The tooltip is anchored to the panel (full-width bubble), so vertically
  // place it just below the icon's row on hover, wherever that row is.
  const place = () => {
    const rootBox = root.getBoundingClientRect()
    const iconBox = wrap.getBoundingClientRect()
    tip.style.top = `${iconBox.bottom - rootBox.top + root.scrollTop + 6}px`
  }
  wrap.addEventListener('mouseenter', place)
  wrap.addEventListener('focus', place)
  return wrap
}

const fmt = (n: number, digits = 2): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US')

/** "13d 4h", "4h 20m", or "12m"/"9s" from a millisecond span. */
const fmtSpan = (ms: number, withSeconds = false): string => {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${m}m`
  if (m < 1 && withSeconds) return `${Math.floor(ms / 1000)}s`
  return `${m}m`
}

/** Short reset date like "1 Oct" for the collapsed details row. */
const fmtShortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })

/** Short approximate date for the ETA line, "≈ 28 Sep". */
const fmtApproxDate = (ms: number): string => `≈ ${fmtShortDate(ms)}`

/**
 * Which tone an account's usage warrants.
 *
 * Percentage alone misreads a large pool — 90% of 10k credits is still 1k
 * left, hardly an emergency — so error also triggers on a small absolute
 * remainder, which is what makes a small plan (where 95% is a handful of
 * credits) turn red at the right moment. Thresholds raised to 85/95 so the
 * warning does not cry wolf on a big plan.
 */
type Tone = 'success' | 'warning' | 'error'
const REMAINING_CRITICAL = 200
function toneFor(pct: number, remaining: number): Tone {
  if (pct >= 95 || remaining < REMAINING_CRITICAL) return 'error'
  if (pct >= 85) return 'warning'
  return 'success'
}
const toneVar = (t: Tone): string =>
  t === 'error' ? 'var(--oc-error, #e05252)'
    : t === 'warning' ? 'var(--oc-warning, #e8935a)'
      : 'var(--oc-success, #4caf6a)'

// ── account card (donut ring + figures + collapsible details + pager) ─────────

/** Recent burn from session activity: daily average over the measured span. */
interface Burn {
  /** Average credits per day, over `spanMs` of actual measured history. */
  perDay: number
  /** How much history the average is based on (earliest activity → now). */
  spanMs: number
}

const DAY_MS = 24 * 60 * 60 * 1000
// Look back at most 7 days; older sessions age out of the window.
const BURN_WINDOW_MS = 7 * DAY_MS
const BURN_MIN_CREDITS = 1

/**
 * Recent daily burn from session activity, divided by the span actually
 * measured — not a fixed 7 — so it does not lie when the history is young.
 *
 * The account's `used` is a single coarse, stepping snapshot, so differencing
 * it extrapolated bursts to absurd rates. `session_usage` records estimated
 * credits per session with real timestamps, so this sums the credits of
 * sessions active in the last 7 days and divides by the time from the earliest
 * such activity to now (clamped to the 7-day window, and to a 1-day floor so a
 * single busy hour does not read as a huge daily rate). `spanMs` is returned so
 * the UI can say how much data it is based on ("over 23h" vs "7-day avg"). As
 * days accumulate the divisor grows toward a true week. Inherits the per-session
 * estimate caveat, surfaced in the UI.
 */
function burnFor(acc: AccountUsage, sessions: SessionUsage[], now: number): Burn | null {
  const cutoff = now - BURN_WINDOW_MS
  let credits = 0
  let earliest = now
  for (const s of sessions) {
    const per = s.accounts?.find((a) => a.accountId === acc.id)
    const last = per?.lastUsed ?? s.lastUsed
    if (last < cutoff) continue
    // Split per account on multi-account snapshots; whole session otherwise.
    credits += per ? per.estCredits : s.estCredits
    earliest = Math.min(earliest, Math.max(cutoff, per?.firstUsed ?? s.firstUsed))
  }
  if (credits < BURN_MIN_CREDITS) return null
  // Floor the divisor at 1 day: with only a few hours of data, dividing by the
  // raw span would turn one busy afternoon into a wildly high "per day".
  const spanMs = now - earliest
  const perDay = credits / Math.max(spanMs, DAY_MS) * DAY_MS
  return { perDay, spanMs }
}

/**
 * Project the 7-day daily burn onto the days left until the reset.
 *
 * This is the question that matters — "will I make it to the reset, and by how
 * much?" — answered from only exact inputs: credits remaining, days to reset,
 * and the measured daily average. `spare` is credits expected to be left at
 * reset (positive) or the shortfall (negative); `runOutMs` is when the credits
 * would hit zero, only meaningful when short.
 */
interface ResetOutlook {
  daysToReset: number
  projectedUse: number
  spare: number
  short: boolean
  runOutMs: number
}
function resetOutlook(acc: AccountUsage, perDay: number, now: number): ResetOutlook | null {
  if (acc.resetAt == null) return null
  const daysToReset = (acc.resetAt - now) / DAY_MS
  if (daysToReset <= 0) return null
  const remaining = Math.max(0, acc.limit - acc.used)
  const projectedUse = perDay * daysToReset
  const spare = remaining - projectedUse
  const runOutMs = perDay > 0 ? (remaining / perDay) * DAY_MS : Infinity
  return { daysToReset, projectedUse, spare, short: spare < 0, runOutMs }
}

function renderAccountCard(
  container: HTMLElement,
  accounts: AccountUsage[],
  sessions: SessionUsage[],
  now: number
): void {
  const card = container.appendChild(el('div', 'card'))
  const idx = ((accountIdx % accounts.length) + accounts.length) % accounts.length
  const acc = accounts[idx]!
  const remaining = Math.max(0, acc.limit - acc.used)
  const t = toneFor(acc.pct, remaining)

  // Header: avatar letter · email · region pill
  const head = card.appendChild(el('div', 'acc-head'))
  head.appendChild(el('span', 'avatar', (acc.email[0] || '?').toUpperCase()))
  head.appendChild(el('span', 'acc-email', acc.email))
  if (!acc.isHealthy) head.appendChild(el('span', 'pill pill-error', 'unhealthy'))
  head.appendChild(el('span', 'pill mono', acc.region))

  // Body: donut ring + figures column
  const body = card.appendChild(el('div', 'acc-body'))
  body.appendChild(donut(acc.pct, t))

  const figures = body.appendChild(el('div', 'acc-figures'))
  const left = figures.appendChild(el('div'))
  const big = left.appendChild(el('span', 'mono big', fmt(remaining)))
  big.after(el('span', 'muted xs', ' credits left'))
  figures.appendChild(el('div', 'hr'))

  // Recent burn: credits/day over the actually-measured span (see burnFor).
  // Needs some activity to mean anything; until then show only the reset.
  const burn = burnFor(acc, sessions, now)
  if (burn) {
    // Say how much history it is based on so the number is not mistaken for a
    // settled weekly average when it is really "over the last N hours/days".
    const spanDays = burn.spanMs / DAY_MS
    const basis =
      spanDays >= 6.5 ? '7-day avg'
        : spanDays >= 1.5 ? `over ${Math.round(spanDays)}d`
          : `over ${Math.max(1, Math.round(burn.spanMs / (60 * 60 * 1000)))}h`
    const rateRow = figures.appendChild(el('div', 'fig-row'))
    rateRow.appendChild(icon(ICON_BOLT))
    const rateText = rateRow.appendChild(el('span', 'mono xs'))
    rateText.appendChild(el('span', undefined, `≈ ${fmt(burn.perDay, 1)} cr/day`))
    rateText.appendChild(el('span', 'subtle', ` · ${basis}`))
    rateRow.appendChild(
      infoIcon(
        `Estimated credits from sessions in the last 7 days, divided by the time actually measured so far (${basis === '7-day avg' ? 'a full week' : basis.replace('over ', '')}). The divisor never drops below one day, so a single busy hour is not read as a huge daily rate. As more days accumulate it settles into a true weekly average. Only counts work on this machine.`
      )
    )

    // The useful question: at this pace, do I make it to the reset, and by how
    // much? Only render the ETA row when there is something real to say — never
    // a bare clock + info with no text (the empty-row bug).
    const outlook = resetOutlook(acc, burn.perDay, now)
    if (outlook) {
      const etaRow = figures.appendChild(el('div', 'fig-row'))
      etaRow.appendChild(icon(ICON_CLOCK))
      const etaText = etaRow.appendChild(el('span', 'mono xs'))
      if (outlook.short) {
        // Runs out before the reset — the day it happens is what matters.
        etaText.style.color = toneVar(acc.pct >= 85 ? 'error' : 'warning')
        etaText.appendChild(el('span', undefined, `~${fmt(-outlook.spare, 0)} cr short`))
        etaText.appendChild(el('span', 'subtle', ` · empty ${fmtApproxDate(now + outlook.runOutMs)}`))
      } else {
        // Makes it — show the margin left at reset.
        etaText.appendChild(el('span', undefined, `~${fmt(outlook.spare, 0)} cr spare at reset`))
      }
      etaRow.appendChild(
        infoIcon(
          'At your recent daily burn, this is how many credits you would have left when the period resets (or how many short, and the day you would run out). Estimated from your measured rate; a busier or quieter week shifts it.'
        )
      )
    } else if (acc.resetAt) {
      // Rate but no reset projection (no reset date): just the reset countdown.
      const resetRow = figures.appendChild(el('div', 'fig-row'))
      resetRow.appendChild(icon(ICON_CLOCK))
      resetRow.appendChild(el('span', 'mono xs subtle', `resets in ${fmtSpan(acc.resetAt - now)}`))
    }
  } else {
    // No usable burn yet — one clear line, not empty rows with lone icons.
    const waitRow = figures.appendChild(el('div', 'fig-row'))
    waitRow.appendChild(icon(ICON_BOLT))
    waitRow.appendChild(el('span', 'xs subtle', 'Usage rate available after your first message'))
    if (acc.resetAt) {
      const resetRow = figures.appendChild(el('div', 'fig-row'))
      resetRow.appendChild(icon(ICON_CLOCK))
      resetRow.appendChild(el('span', 'mono xs subtle', `resets in ${fmtSpan(acc.resetAt - now)}`))
    }
  }

  // Details toggle + collapsible plan/reset/overage
  const toggle = card.appendChild(el('button', 'details-toggle'))
  toggle.setAttribute('type', 'button')
  toggle.appendChild(el('span', undefined, 'Details'))
  const chev = toggle.appendChild(icon(ICON_CHEVRON_DOWN, 0.6))
  chev.style.transform = detailsOpen ? 'rotate(180deg)' : 'rotate(0deg)'
  toggle.addEventListener('click', () => {
    detailsOpen = !detailsOpen
    void host.storage.set(DETAILS_OPEN_KEY, detailsOpen).catch(() => {})
    void paint(true)
  })

  if (detailsOpen) {
    const details = card.appendChild(el('div', 'details'))
    if (acc.plan) details.appendChild(detailRow('Plan', acc.plan))
    if (acc.resetAt) {
      details.appendChild(
        detailRow('Resets', `${fmtShortDate(acc.resetAt)} · ${fmtSpan(acc.resetAt - now)} left`)
      )
    }
    if (acc.overageStatus) {
      const rate = acc.overageRate != null ? `$${fmt(acc.overageRate, 2)}/credit` : ''
      const cap = acc.overageCap != null ? ` · cap ${fmtInt(acc.overageCap)}` : ''
      const value =
        acc.overageStatus === 'DISABLED' ? 'disabled' : `${rate}${cap}`.trim() || acc.overageStatus
      details.appendChild(detailRow('Overage', value))
    }
    if (acc.currentOverages) {
      details.appendChild(detailRow('Overages spent', fmt(acc.currentOverages)))
    }
  }

  // Pager, only with more than one account
  if (accounts.length > 1) {
    const pager = card.appendChild(el('div', 'pager'))
    const prev = pager.appendChild(el('button', 'navbtn'))
    prev.setAttribute('type', 'button')
    prev.setAttribute('aria-label', 'Previous account')
    prev.appendChild(icon(ICON_CHEVRON_LEFT, 0.8))
    prev.addEventListener('click', () => {
      accountIdx = idx - 1
      void paint(true)
    })
    const dots = pager.appendChild(el('span', 'dots'))
    accounts.forEach((_, i) => {
      const dot = dots.appendChild(el('span', 'dot'))
      if (i === idx) dot.classList.add('dot-on')
    })
    const next = pager.appendChild(el('button', 'navbtn'))
    next.setAttribute('type', 'button')
    next.setAttribute('aria-label', 'Next account')
    next.appendChild(icon(ICON_CHEVRON_RIGHT, 0.8))
    next.addEventListener('click', () => {
      accountIdx = idx + 1
      void paint(true)
    })
  }
}

const CIRC = 2 * Math.PI * 36 // r=36
function donut(pct: number, t: Tone): SVGElement {
  const svg = svgEl('svg', { width: 88, height: 88, viewBox: '0 0 88 88', class: 'donut' })
  svg.appendChild(
    svgEl('circle', { cx: 44, cy: 44, r: 36, fill: 'none', stroke: 'var(--oc-border, #333)', 'stroke-width': 6.5 })
  )
  const arc = svgEl('circle', {
    cx: 44, cy: 44, r: 36, fill: 'none', stroke: toneVar(t), 'stroke-width': 6.5,
    'stroke-linecap': 'round', 'stroke-dasharray': CIRC.toFixed(2),
    'stroke-dashoffset': (CIRC * (1 - Math.min(100, Math.max(0, pct)) / 100)).toFixed(2),
    transform: 'rotate(-90 44 44)'
  })
  svg.appendChild(arc)
  const pctText = svgEl('text', {
    x: 44, y: 47, 'text-anchor': 'middle', 'font-size': 19, 'font-weight': 700,
    fill: 'var(--oc-fg, #fff)'
  })
  pctText.textContent = `${pct}%`
  svg.appendChild(pctText)
  const used = svgEl('text', {
    x: 44, y: 60, 'text-anchor': 'middle', 'font-size': 7.5, fill: 'var(--oc-muted, #888)'
  })
  used.textContent = 'used'
  svg.appendChild(used)
  return svg
}

function detailRow(label: string, value: string): HTMLElement {
  const row = el('div', 'detail-row')
  row.appendChild(el('span', 'subtle xs', label))
  row.appendChild(el('span', 'mono xs muted', value))
  return row
}

// ── sessions ──────────────────────────────────────────────────────────────────

function renderSessions(
  container: HTMLElement,
  sessions: SessionUsage[],
  emailById: Map<string, string>
): void {
  if (!sessions.length) return
  // The section is a flex column that fills the space left under the (fixed)
  // account card, so the heading stays put and only the row list scrolls.
  const section = container.appendChild(el('div', 'sessions-section'))
  const heading = section.appendChild(el('div', 'sec-head'))
  heading.appendChild(el('span', 'sec-title', 'Recent sessions'))
  heading.appendChild(el('span', 'subtle xs', '(estimated)'))
  // The estimate caveat lives in an info tooltip on the heading.
  heading.appendChild(
    infoIcon(
      'Credits per session are estimated: Kiro bills per request, not per token, and the account total is split across sessions by request share. A shared account mixes in other users.'
    )
  )

  const list = section.appendChild(el('div', 'sessions'))
  for (const s of sessions.slice(0, 12)) renderSessionRow(list, s, emailById)
}

/**
 * The best readable name for a session row, in priority order:
 * the plugin's recorded title, the host title (for the active/known session),
 * the directory basename, then the raw session id (shown muted-mono).
 */
function sessionName(s: SessionUsage, isCurrent: boolean): { text: string; isId: boolean } {
  const cached = sessionTitleCache.get(s.sessionId)?.title
  const hostTitle = isCurrent ? currentSessionTitle : cached
  const title = s.title || (hostTitle && hostTitle !== s.sessionId ? hostTitle : undefined)
  if (title) return { text: title, isId: false }
  const dir = s.directory?.split('/').pop()
  if (dir) return { text: dir, isId: false }
  return { text: s.sessionId, isId: true }
}

function renderSessionRow(
  container: HTMLElement,
  s: SessionUsage,
  emailById: Map<string, string>
): void {
  const isCurrent = currentSessionId != null && s.sessionId === currentSessionId
  const name = sessionName(s, isCurrent)

  const row = container.appendChild(el('button', `srow${isCurrent ? ' current' : ''}`))
  row.setAttribute('type', 'button')
  row.addEventListener('click', () => void host.openSession(s.sessionId).catch(() => {}))

  const top = row.appendChild(el('div', 'srow-top'))
  const left = top.appendChild(el('div', 'srow-name'))
  // A raw id renders muted-mono, like the design; a real title renders plain.
  left.appendChild(el('span', name.isId ? 'srow-title mono muted' : 'srow-title', name.text))
  if (isCurrent) left.appendChild(el('span', 'mono now', 'now'))

  const figures = top.appendChild(el('span', 'srow-figures mono'))
  figures.appendChild(el('span', 'srow-credits', fmt(s.estCredits, 1)))
  figures.appendChild(el('span', 'subtle', ` cr · ${s.requests} req`))

  // The directory, only when it is a real project path that adds something.
  // Direct chats live under OpenChamber's own chats store
  // (…/openchamber/chats/…), which is not a project location — showing it is
  // just noise, so those are suppressed.
  const dir = s.directory
  const isChatStore = !!dir && /[/\\]openchamber[/\\]chats[/\\]/i.test(dir)
  if (!name.isId && dir && !isChatStore && dir.split('/').pop() !== name.text) {
    row.appendChild(el('div', 'srow-path mono subtle', dir))
  }

  // Per-account split, only when more than one account served the session.
  if (s.accounts && s.accounts.length > 1) {
    const split = s.accounts
      .map((a) => {
        const who = (emailById.get(a.accountId) ?? a.accountId).split('@')[0]!.slice(0, 12)
        return `${who}: ~${fmt(a.estCredits, 1)} cr · ${a.requests} req`
      })
      .join('   ·   ')
    row.appendChild(el('div', 'srow-split subtle', split))
  }
}

// ── plugin card + freshness ───────────────────────────────────────────────────

function renderPlugin(
  container: HTMLElement,
  installed: string | undefined,
  instances: PluginInstance[]
): void {
  const versions = new Set(instances.map((i) => i.version))
  const split = versions.size > 1
  const outdated =
    !split && installed != null && latestVersion != null &&
    compareSemver(installed, latestVersion) < 0

  const card = container.appendChild(el('div', 'plugin-card'))
  const top = card.appendChild(el('div', 'plugin-top'))
  const idcol = top.appendChild(el('span', 'plugin-id'))
  const dot = idcol.appendChild(el('span', 'dot'))
  dot.style.background = outdated || split ? toneVar('warning') : toneVar('success')
  idcol.appendChild(el('span', 'mono plugin-name', PLUGIN_PKG))

  const right = top.appendChild(el('span', 'plugin-right'))
  right.appendChild(el('span', 'mono xs muted', installed ? `v${installed}` : 'version?'))
  const badge = right.appendChild(
    el('span', 'pill', split ? 'versions differ' : outdated ? 'update available' : 'up to date')
  )
  if (outdated || split) {
    badge.style.color = toneVar('warning')
    badge.style.background = 'color-mix(in srgb, var(--oc-warning, #e8935a) 14%, transparent)'
  }

  if (outdated) {
    const note = card.appendChild(el('div', 'plugin-note'))
    note.appendChild(el('span', 'mono xs', `v${latestVersion} available`))
    const copy = note.appendChild(el('button', 'linkbtn', 'Copy update command'))
    copy.setAttribute('type', 'button')
    copy.addEventListener('click', () => {
      void host.writeClipboard(`npm install -g ${PLUGIN_PKG}@latest`).catch(() => {})
      copy.textContent = 'Copied!'
      setTimeout(() => (copy.textContent = 'Copy update command'), 1500)
    })
  }

  if (split) {
    const note = card.appendChild(el('div', 'plugin-note col'))
    note.appendChild(
      el('span', 'xs', `${versions.size} versions running — update every OpenCode install.`)
    )
    for (const i of instances) {
      const line = note.appendChild(el('div', 'inst-line'))
      line.appendChild(el('span', 'mono xs', `v${i.version}${i.self ? ' · here' : ''}`))
      line.appendChild(el('span', 'mono xs subtle', shortenPath(i.source) ?? `pid ${i.pid}`))
    }
  }
}

/** Trim an install path to its tail so the meaningful part fits the panel. */
function shortenPath(source: string | undefined): string | undefined {
  if (!source) return undefined
  const parts = source.split('/')
  return parts.length <= 4 ? source : `…/${parts.slice(-4).join('/')}`
}

function renderFreshness(container: HTMLElement, writtenAt: number): void {
  // No manual refresh button: the panel repolls every POLL_MS and repaints on
  // session changes on its own, so a button would only re-read the same file.
  const bar = container.appendChild(el('div', 'freshness'))
  const label = bar.appendChild(el('span', 'subtle xs'))
  let staleShown = false
  const tick = () => {
    const age = Date.now() - writtenAt
    label.textContent = `Updated ${fmtSpan(age, true)} ago`
    if (age > STALE_MS && !staleShown) {
      staleShown = true
      const pill = bar.insertBefore(el('span', 'pill', 'cached'), bar.firstChild)
      pill.style.color = toneVar('warning')
      pill.style.marginRight = '0.4em'
    }
  }
  tick()
  const ticker = setInterval(tick, 1_000)
  mounted.push({ dispose: () => clearInterval(ticker) })
}

// ── missing-file / waiting state ──────────────────────────────────────────────

/**
 * What to show when kiro-usage.json is absent.
 *
 * The plugin writes this file during init — including when the startup usage
 * refresh fails — so a 2.2.0+ instance produces it within seconds of OpenCode
 * starting, before any request. A missing file therefore means no supported
 * instance has initialised yet: almost always the plugin is older than 2.2.0,
 * occasionally OpenCode is still starting. We fetch npm to say whether an
 * update is waiting, and the poll loop repaints on its own once the file lands.
 */
async function renderMissingFile(now: number): Promise<void> {
  await refreshLatestVersion(now)
  const behind = latestVersion != null && compareSemver(latestVersion, MIN_SUPPORTED_VERSION) >= 0
  const body = behind
    ? `Usage tracking needs ${PLUGIN_PKG} v${MIN_SUPPORTED_VERSION} or newer. The latest is v${latestVersion}. Update the plugin, then it appears within seconds of starting OpenCode.`
    : `Usage tracking needs ${PLUGIN_PKG} v${MIN_SUPPORTED_VERSION} or newer. If OpenCode just started, this fills in within a few seconds.`
  mounted.push(
    mountBanner(root, {
      tone: 'warning',
      title: 'Waiting for the Kiro plugin',
      body,
      action: {
        label: 'Copy update command',
        onClick: () => void host.writeClipboard(`npm install -g ${PLUGIN_PKG}@latest`).catch(() => {})
      }
    })
  )
}

// ── data read + paint ─────────────────────────────────────────────────────────

let lastFileKey = ''
// The candidate path that last held the snapshot, tried first next time so a
// steady state does not re-probe both locations on every poll.
let resolvedUsageFile: string | null = null

async function readUsageFile(): Promise<UsageFile> {
  const order = resolvedUsageFile
    ? [resolvedUsageFile, ...USAGE_FILES.filter((p) => p !== resolvedUsageFile)]
    : USAGE_FILES
  let lastError: unknown
  for (const path of order) {
    try {
      const { content } = await host.readFile(path)
      resolvedUsageFile = path
      return JSON.parse(content) as UsageFile
    } catch (error) {
      lastError = error
      if (error instanceof HostRequestError && error.code === 'NOT_FOUND') continue
      throw error
    }
  }
  resolvedUsageFile = null
  throw lastError
}

// Serialise paints. onReady, onSession and the poll can all fire within the
// same tick on a cold start; overlapping runs raced on lastFileKey and on
// clear()/append, which could leave #root cleared-but-not-filled and then every
// later poll SKIP'd on a matching key — an empty panel that only a data change
// would recover. A single-slot queue guarantees paints run one at a time.
let painting: Promise<void> | null = null
let repaintQueued = false
function paint(force = false): Promise<void> {
  if (painting) {
    // Coalesce: remember that another paint is wanted, run it once the
    // in-flight one finishes. A forced request wins.
    repaintQueued = repaintQueued || force
    return painting
  }
  painting = paintOnce(force).finally(() => {
    painting = null
    if (repaintQueued) {
      repaintQueued = false
      void paint(true)
    }
  })
  return painting
}

async function paintOnce(force: boolean): Promise<void> {
  let file: UsageFile
  try {
    file = await readUsageFile()
  } catch (error) {
    clear()
    lastFileKey = '' // never leave a key that would SKIP the recovery repaint
    if (error instanceof HostRequestError && error.code === 'NOT_FOUND') {
      await renderMissingFile(Date.now())
    } else {
      const msg = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error)
      mounted.push(mountBanner(root, { tone: 'error', title: 'Could not read usage', body: msg }))
    }
    return
  }

  const now = Date.now()

  // Backfill resetAt before computing the repaint key, so a snapshot that
  // dropped it does not count as a different file (and the ETA stays stable).
  for (const acc of file.accounts ?? []) {
    if (typeof acc.resetAt === 'number') lastResetAt.set(acc.id, acc.resetAt)
    else {
      const known = lastResetAt.get(acc.id)
      if (known != null) acc.resetAt = known
    }
  }

  // Repaint key includes UI state that changes what is drawn but not the file.
  const key = JSON.stringify(file) + `|${detailsOpen}|${accountIdx}|${currentSessionId ?? ''}|${latestVersion ?? ''}`
  if (!force && key === lastFileKey) return

  // The npm version check is a network call (up to 20s, can hang offline). It
  // must NOT gate the paint — render the file data right away and check the
  // version in the background, repainting only when it actually changed.
  void refreshLatestVersion(now).then((changed) => {
    if (changed) void paint(true)
  })

  // Render synchronously from here down — no awaits — so the key is only set
  // after #root is fully populated, and clear()+append cannot be interleaved.
  clear()

  if (!file.accounts?.length) {
    lastFileKey = key
    mounted.push(
      mountEmpty(root, { title: 'No Kiro accounts', body: 'Sign in to Kiro in OpenCode first.' })
    )
    return
  }

  // Layout: #root is a fixed-height flex column. The account card and the
  // "Recent sessions" heading stay put; only the session rows scroll; the
  // footer (plugin card + freshness) stays pinned at the bottom. So just the
  // list of rows takes the flexible middle space — everything else is fixed.
  const wrap = root.appendChild(el('div', 'wrap'))
  renderAccountCard(wrap, file.accounts, file.sessions ?? [], now)
  const emailById = new Map(file.accounts.map((a) => [a.id, a.email]))
  renderSessions(wrap, file.sessions ?? [], emailById)

  const footer = wrap.appendChild(el('div', 'footer'))
  renderPlugin(footer, file.pluginVersion, file.pluginInstances ?? [])
  renderFreshness(footer, file.writtenAt || now)

  // Key set only now, after #root is fully populated — never mid-render.
  lastFileKey = key
}

// ── styles ────────────────────────────────────────────────────────────────────

function injectStyles(): void {
  const style = document.createElement('style')
  // Colours use OpenChamber's own tokens so the panel matches the app's theme
  // in light or dark; numbers use the host mono token. Sizes track the host
  // font (applyHostReady sets ~0.875rem on the root).
  style.textContent = `
    /* Lock the panel to the rail width so no child (a long path, a wide title)
       can widen it, which showed as the panel jumping wider on session switch. */
    #root { color: var(--oc-fg); max-width: 100%; height: 100%; overflow: hidden; box-sizing: border-box; }
    .mono { font-family: var(--oc-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
    .muted { color: var(--oc-muted, #8b8b93); }
    /* Readable secondary text. Maps to the host's muted token (~5:1 on both
       themes), NOT --oc-subtle: that token is ~2.8:1, fine for borders and
       icons but unreadable as body text on a dark background. */
    .subtle { color: var(--oc-muted, #8b8b93); }
    .xs { font-size: 0.8em; }
    .ico { flex-shrink: 0; }
    /* Fill the panel height so the freshness line can anchor to the bottom via
       margin-top:auto; min-height:100% (not height) lets it grow past the
       viewport and scroll when content is tall. */
    /* Full-height column: account card + footer fixed, only the session rows
       scroll. The sessions-section takes the flexible middle; its heading stays
       and its .sessions list is the actual scroll area. */
    .wrap { display: flex; flex-direction: column; gap: 1.3em; max-width: 100%; min-width: 0; height: 100%; box-sizing: border-box; }
    .sessions-section { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

    .card { display: flex; flex-direction: column; gap: 0.75em; padding: 1.1em; border-radius: 0.72em; background: var(--oc-elevated, rgba(127,127,127,0.06)); border: 1px solid var(--oc-border, transparent); }
    .acc-head { display: flex; align-items: center; gap: 0.6em; }
    .avatar { width: 1.35em; height: 1.35em; border-radius: 999px; background: var(--oc-hover, rgba(127,127,127,0.12)); display: flex; align-items: center; justify-content: center; font-size: 0.7em; font-weight: 700; color: var(--oc-muted, #888); flex-shrink: 0; }
    .acc-email { font-size: 0.95em; font-weight: 500; color: var(--oc-muted, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .pill { font-size: 0.72em; color: var(--oc-muted, #888); background: var(--oc-hover, rgba(127,127,127,0.12)); border-radius: 999px; padding: 0.15em 0.6em; flex-shrink: 0; white-space: nowrap; }
    .pill-error { color: var(--oc-error, #e05252); background: color-mix(in srgb, var(--oc-error, #e05252) 14%, transparent); }

    .acc-body { display: flex; align-items: center; gap: 1.15em; }
    .donut { flex-shrink: 0; }
    .acc-figures { display: flex; flex-direction: column; gap: 0.45em; min-width: 0; flex: 1; }
    .big { font-size: 1.3em; font-weight: 600; }
    .hr { height: 1px; background: var(--oc-border, #333); }
    .fig-row { display: flex; align-items: center; gap: 0.4em; color: var(--oc-muted, #8b8b93); }
    .fig-row .mono { color: var(--oc-muted, #888); }

    .details-toggle { align-self: center; display: flex; align-items: center; gap: 0.3em; font-size: 0.78em; color: var(--oc-muted, #8b8b93); background: transparent; border: 0; padding: 0.15em 0.6em; border-radius: 0.45em; cursor: pointer; }
    .details-toggle:hover { background: var(--oc-hover, rgba(127,127,127,0.12)); }
    .details-toggle .ico { transition: transform 0.15s ease; }
    .details { display: flex; flex-direction: column; gap: 0.45em; padding-top: 0.6em; border-top: 1px solid var(--oc-border, #333); }
    .detail-row { display: flex; align-items: center; justify-content: space-between; gap: 0.8em; }

    .pager { display: flex; align-items: center; justify-content: center; gap: 0.9em; margin-top: 0.15em; }
    .navbtn { width: 1.7em; height: 1.7em; border-radius: 0.45em; border: 0; background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--oc-muted, #8b8b93); padding: 0; }
    .navbtn:hover { background: var(--oc-hover, rgba(127,127,127,0.12)); color: var(--oc-fg); }
    .dots { display: flex; align-items: center; gap: 0.45em; }
    .dot { width: 0.45em; height: 0.45em; border-radius: 999px; background: var(--oc-border, #333); }
    .dot-on { background: var(--oc-primary, #e8935a); }

    .sec-head { margin-bottom: 0.3em; display: flex; align-items: center; gap: 0.4em; }
    .sec-title { font-size: 0.92em; font-weight: 600; }
    /* The wrap is static; the tooltip anchors to the panel (#root), not the icon,
       so it spans the full rail with margins and stays readable wherever the icon
       sits — a right/left-aligned bubble clipped off-panel for the mid-row icons. */
    .info-wrap { display: inline-flex; align-items: center; cursor: help; flex-shrink: 0; outline: none; }
    .info-ico { color: var(--oc-muted, #8b8b93); flex-shrink: 0; }
    .info-wrap:hover .info-ico, .info-wrap:focus-visible .info-ico { color: var(--oc-fg); }
    #root { position: relative; }
    .tip { position: absolute; left: 12px; right: 12px; z-index: 20; padding: 0.55em 0.7em; border-radius: 0.5em; background: var(--oc-elevated, #1c1c20); color: var(--oc-fg, #e9e9ec); border: 1px solid var(--oc-border, #333); box-shadow: 0 4px 16px rgba(0,0,0,0.35); font-size: 0.78em; line-height: 1.45; font-weight: 400; white-space: normal; opacity: 0; visibility: hidden; transition: opacity 0.12s ease; pointer-events: none; }
    .info-wrap:hover .tip, .info-wrap:focus-visible .tip { opacity: 1; visibility: visible; }
    /* Everything below constrains the session rows so a long path or title can
       never push the panel wider than its rail. The whole panel is width-locked
       (see #root) and each row + its children carry min-width:0 so ellipsis
       actually kicks in instead of the element demanding its full text width. */
    .sessions { display: flex; flex-direction: column; min-width: 0; max-width: 100%; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
    /* Fixed row height so every row is the same, whether it shows a path or not.
       Tall enough for the two-line case (title + path); one-line rows center in
       the same box. min-height keeps it even if a font makes lines taller. */
    .srow { display: flex; flex-direction: column; justify-content: center; gap: 0.2em; width: 100%; min-width: 0; max-width: 100%; height: 3.9em; min-height: 3.9em; box-sizing: border-box; text-align: left; padding: 0.5em; border: 0; border-left: 2px solid transparent; border-bottom: 1px solid var(--oc-border, #28282d); background: transparent; color: inherit; font: inherit; cursor: pointer; transition: background 0.12s ease; }
    .srow:last-child { border-bottom: 0; }
    .srow:hover { background: var(--oc-hover, rgba(127,127,127,0.1)); }
    .srow.current { border-left-color: var(--oc-primary, #e8935a); }
    .srow-top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8em; min-width: 0; }
    .srow-name { display: flex; align-items: center; gap: 0.45em; min-width: 0; flex: 1; }
    .srow-title { font-size: 1em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .srow-title.muted { font-weight: 400; }
    .now { font-size: 0.72em; font-weight: 600; color: var(--oc-primary, #e8935a); flex-shrink: 0; }
    .srow-figures { font-size: 0.92em; flex-shrink: 0; white-space: nowrap; }
    .srow-credits { font-weight: 500; }
    /* width:0 + min-width:0 makes the row's width the authority; the block then
       fills it and ellipsis-clips, instead of overflow-wrap letting the text
       claim its natural width (which reported a 430px scrollWidth on a 360 rail). */
    .srow-path { font-size: 0.8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; width: 100%; min-width: 0; box-sizing: border-box; }
    .srow-split { font-size: 0.76em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; width: 100%; min-width: 0; box-sizing: border-box; }
    .caption { font-size: 0.76em; line-height: 1.5; margin-top: 0.6em; }

    .plugin-card { display: flex; flex-direction: column; gap: 0.6em; padding: 0.75em 0.9em; border-radius: 0.55em; background: var(--oc-elevated, rgba(127,127,127,0.06)); border: 1px solid var(--oc-border, transparent); }
    .plugin-top { display: flex; align-items: center; justify-content: space-between; gap: 0.8em; }
    .plugin-id { display: flex; align-items: center; gap: 0.5em; min-width: 0; }
    .dot { width: 0.45em; height: 0.45em; border-radius: 999px; flex-shrink: 0; }
    .plugin-name { font-size: 0.9em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .plugin-right { display: flex; align-items: center; gap: 0.45em; flex-shrink: 0; }
    .plugin-note { display: flex; align-items: center; justify-content: space-between; gap: 0.7em; padding: 0.5em 0.6em; border-radius: 0.45em; background: color-mix(in srgb, var(--oc-warning, #e8935a) 12%, transparent); }
    .plugin-note.col { flex-direction: column; align-items: stretch; gap: 0.35em; }
    .inst-line { display: flex; align-items: center; justify-content: space-between; gap: 0.6em; }

    /* The footer (plugin card + freshness) anchors to the panel bottom; the
       account/sessions above take their natural height and this fills the rest. */
    .footer { display: flex; flex-direction: column; gap: 1.3em; min-width: 0; flex-shrink: 0; }
    .freshness { display: flex; align-items: center; justify-content: center; padding: 0.2em 0.15em 0; }
    .linkbtn { font-size: 0.82em; font-weight: 500; color: var(--oc-warning, #e8935a); background: transparent; border: 0; padding: 0.2em 0.5em; border-radius: 0.4em; cursor: pointer; flex-shrink: 0; }
    .linkbtn:hover { background: var(--oc-hover, rgba(127,127,127,0.12)); }
    .linkbtn.primary { color: var(--oc-primary, #e8935a); }
  `
  document.head.appendChild(style)
}

// ── host wiring ───────────────────────────────────────────────────────────────

async function trackCurrentProject(): Promise<void> {
  try {
    const projects = await host.listProjects()
    const projectId = projects.projects[0]?.id
    if (!projectId) return
    await host.onSessions(projectId, () => void paint(true))
  } catch {
    // sessions capability not granted or nothing open — degrade silently.
  }
}

let started = false
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement)
  if (started) return
  started = true
  injectStyles()
  void loadUiState()
  void paint(true)
  void trackCurrentProject()
  setInterval(() => void paint(), POLL_MS)
})

host.onSession((session) => {
  const next = session?.id ?? null
  if (session?.id && session.title && session.title !== session.id) {
    rememberSessionTitle(session.id, session.title, Date.now())
  }
  const nextTitle = session?.title ?? null
  if (next === currentSessionId && nextTitle === currentSessionTitle) return
  currentSessionId = next
  currentSessionTitle = nextTitle
  void paint(true)
})
