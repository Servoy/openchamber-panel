/**
 * Kiro Usage panel.
 *
 * Data contract: the panel reads ONLY `kiro-usage.json`, written by the
 * @servoy/opencode-kiro-auth plugin. The exact schema (field names, types, and
 * which values are exact vs estimated) is documented in ./schema.ts and in the
 * README. Rules this file follows everywhere:
 *
 *  - Estimates are shown with "~" and an "est." tag, never as hard numbers.
 *  - A missing value is "not reported", never 0.
 *  - Colours come only from OpenChamber's `--oc-*` tokens.
 */
import { connectHost, HostRequestError } from '@openchamber/sdk'
import { applyHostReady, mountBanner, mountEmpty } from '@openchamber/sdk/ui'
import type { AccountUsage, PluginInstance, SessionUsage, TokenCounts, UsageFile } from './schema'
import {
  aggregateTools,
  recentBurn,
  creditsPerRequest,
  isPreMetering,
  hasInsightFields,
  dailySeries,
  DAY_MS,
  projectionFor,
  type PaceView,
  promptTokens,
  requests7d,
  sortSessions,
  toolCallsOf,
  tokenSummary,
  accountsInUse,
  turnSplit,
  trendStats,
  type Burn,
  type Projection,
  type SessionSort
} from './insights'
import {
  barChart,
  el,
  estCr,
  fmt,
  fmtAgo,
  fmtApproxDate,
  fmtCompact,
  fmtDay,
  fmtDuration,
  fmtInt,
  fmtShortDate,
  fmtSpan,
  hbar,
  segBar,
  ICON_ALERT,
  ICON_ARROW_LEFT,
  ICON_BOLT,
  ICON_CHEVRON_DOWN,
  ICON_CLOCK,
  icon,
  infoIcon,
  notReported,
  ring,
  toneFor,
  toneText,
  toneVar,
  type Tone
} from './ui'
import { STYLES } from './styles'

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
  '~/AppData/Roaming/opencode/kiro-usage.json',
  // Servoy launches OpenCode with XDG_CONFIG_HOME=~/.servoy on every OS, and the
  // plugin follows XDG_CONFIG_HOME, so its state then lives here instead.
  '~/.servoy/opencode/kiro-usage.json'
]
const POLL_MS = 10_000
// Beyond this the snapshot is treated as stale — the plugin syncs at most once a
// minute and only after a request, so this flags "no fresh reading lately".
const STALE_MS = 90_000
// Beyond this the "stale" notice escalates from neutral to a warning.
const VERY_STALE_MS = 6 * 60 * 60 * 1000

/** The plugin version that first writes the usage snapshot. */
const MIN_SUPPORTED_VERSION = '2.11.0'

const PLUGIN_PKG = '@servoy/opencode-kiro-auth'

const host = connectHost()
const root = document.querySelector('#root') as HTMLElement

let mounted: Array<{ dispose: () => void }> = []
const clear = () => {
  for (const block of mounted) block.dispose()
  mounted = []
  root.innerHTML = ''
}

// ── UI state ──────────────────────────────────────────────────────────────────

// The current OpenChamber session id, to highlight its row in the session list.
let currentSessionId: string | null = null
// The active session's title from the host, used to name its row when the
// plugin has not recorded a title yet.
let currentSessionTitle: string | null = null
// Last known reset time per account, ms. A fresh snapshot can omit resetAt, which
// would make the projection flicker away on a repaint.
const lastResetAt = new Map<string, number>()
// Which account is shown; kept across repaints so a poll does not reset it.
let accountIdx = 0
// Drill-down: the session whose full breakdown is open, or null for the overview.
let detailId: string | null = null
// A view change (open/close drill-down) starts at the top; a poll repaint keeps
// the scroll position so nothing jumps.
let resetScrollNext = false

type Range = 7 | 14
let detailsOpen = false
let sortMode: SessionSort = 'cost'
let rangeDays: Range = 14
let showAllTools = false
// Drill-down: the session whose full tool list is expanded. Not persisted, and another session opens collapsed.
let showAllSessionTools: string | null = null

const SESSION_TITLES_KEY = 'session-titles'
const DETAILS_OPEN_KEY = 'details-open'
const PREFS_KEY = 'ui-prefs'
/** Trim to this many entries on save, so the stored value stays well under
 * the 64 KiB-per-key limit regardless of how long the panel has run. */
const SESSION_TITLES_MAX = 300
const sessionTitleCache = new Map<string, { title: string; seenAt: number }>()
let sessionTitlesLoaded = false
// Not persisted: a long list is a deliberate, temporary expansion.
let showAllSessions = false
let saveTitlesTimer: ReturnType<typeof setTimeout> | undefined

const SORTS: SessionSort[] = ['cost', 'recent', 'requests', 'tokens']

const RESET_AT_KEY = 'last-reset-at'

/** Persist the last known reset per account, so a reload during a snapshot without it keeps the projection. */
function saveResetAt(): void {
  void host.storage.set(RESET_AT_KEY, Object.fromEntries(lastResetAt)).catch(() => {})
}

function savePrefs(): void {
  void host.storage.set(PREFS_KEY, { sortMode, rangeDays, showAllTools }).catch(() => {})
}

async function loadUiState(): Promise<void> {
  try {
    const [titles, open, prefs, resets] = await Promise.all([
      host.storage.get(SESSION_TITLES_KEY),
      host.storage.get(DETAILS_OPEN_KEY),
      host.storage.get(PREFS_KEY),
      host.storage.get(RESET_AT_KEY)
    ])
    if (resets && typeof resets === 'object') {
      for (const [id, v] of Object.entries(resets as Record<string, unknown>)) {
        // A fresh snapshot may already have set it; that one wins.
        if (typeof v === 'number' && !lastResetAt.has(id)) lastResetAt.set(id, v)
      }
    }
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
    if (prefs && typeof prefs === 'object') {
      const p = prefs as { sortMode?: unknown; rangeDays?: unknown; showAllTools?: unknown }
      if (SORTS.includes(p.sortMode as SessionSort)) sortMode = p.sortMode as SessionSort
      if (p.rangeDays === 7 || p.rangeDays === 14) rangeDays = p.rangeDays
      if (typeof p.showAllTools === 'boolean') showAllTools = p.showAllTools
    }
  } catch {
    // No stored state yet, or storage unavailable — start with defaults.
  } finally {
    sessionTitlesLoaded = true
    void paint(true)
  }
}

function scheduleSaveSessionTitles(): void {
  if (saveTitlesTimer) clearTimeout(saveTitlesTimer)
  // Debounced, and held back until the initial load landed: writing earlier would
  // let that load's merge clobber a just-renamed entry with a stale one.
  saveTitlesTimer = setTimeout(() => {
    if (!sessionTitlesLoaded) {
      scheduleSaveSessionTitles()
      return
    }
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

// Latest published version, taken from the snapshot (the plugin checks npm; the
// panel cannot, since a sandboxed request needs a connected token integration).
let latestVersion: string | null = null

/**
 * Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Pre-release tags are ignored; only the numeric core is compared.
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

/** Repaint with UI state changed; every interactive control goes through this. */
function repaint(resetScroll = false): void {
  if (resetScroll) resetScrollNext = true
  void paint(true)
}

// ── shared view context + small builders ──────────────────────────────────────

interface Ctx {
  file: UsageFile
  now: number
  emailById: Map<string, string>
  acc: AccountUsage
  burn: Burn | null
  proj: Projection
}

const estTag = (src?: string): HTMLElement => {
  const t = el('span', 'tag-est', src ? `est. · ${src}` : 'est.')
  t.setAttribute('aria-label', src ? `estimated, source ${src}` : 'estimated')
  return t
}

function section(
  parent: HTMLElement,
  title: string,
  opts: { est?: boolean; exact?: boolean; src?: string; info?: string; right?: HTMLElement } = {}
): HTMLElement {
  const box = parent.appendChild(el('section', 'sec'))
  const head = box.appendChild(el('div', 'sec-head'))
  head.appendChild(el('span', 'sec-title', title))
  if (opts.est) head.appendChild(estTag(opts.src))
  // Exact is the default a reader assumes, so only estimates carry a tag.
  if (opts.info) head.appendChild(infoIcon(opts.info))
  if (opts.right) {
    const spacer = head.appendChild(el('span', 'grow'))
    spacer.after(opts.right)
  }
  return box
}

/** A key figure: label on top, value (or "not reported") below, optional sub line. */
function tile(
  label: string,
  value: string | null,
  sub?: string,
  opts: { est?: boolean; tone?: Tone } = {}
): HTMLElement {
  const t = el('div', 'tile')
  const lab = t.appendChild(el('div', 'tile-label'))
  lab.appendChild(el('span', undefined, label))
  if (opts.est) lab.appendChild(estTag())
  const val = t.appendChild(el('div', 'tile-value mono'))
  if (value == null) val.appendChild(notReported())
  else {
    val.textContent = value
    if (opts.tone) val.style.color = toneText(opts.tone)
  }
  if (sub) t.appendChild(el('div', 'tile-sub xs subtle', sub))
  return t
}

// Colours per account, by its position in the current account list, so an
// account keeps its colour across rows. An account no longer in the list (removed
// or signed out) is muted: the session rows still carry its share for up to 7 days.
const ACCT_COLORS = ['var(--oc-primary)', 'var(--oc-info)', 'var(--oc-success)', 'var(--oc-warning)']

interface AcctInfo {
  label: string
  color: string
  removed: boolean
}

function acctInfo(c: Ctx, accountId: string): AcctInfo {
  const i = c.file.accounts.findIndex((a) => a.id === accountId)
  // --oc-muted, not --oc-subtle: subtle is meant for borders and is near-invisible on the panel background.
  if (i === -1) return { label: accountId.slice(0, 6), color: 'var(--oc-muted)', removed: true }
  return {
    label: c.file.accounts[i]!.email.split('@')[0]!,
    color: ACCT_COLORS[i % ACCT_COLORS.length]!,
    removed: false
  }
}

/** One account's chip: colour dot, name (or short id + "removed"), then the numbers. */
function acctChip(info: AcctInfo, credits: number, requests: number): HTMLElement {
  const chip = el('span', 'acct-chip')
  const dot = chip.appendChild(el('span', 'dot'))
  dot.style.background = info.color
  const name = chip.appendChild(el('span', info.removed ? 'acct-chip-name mono acct-gone' : 'acct-chip-name', info.label))
  if (info.removed) name.after(el('span', 'xs acct-gone', 'removed'))
  chip.appendChild(el('span', 'mono xs subtle', `${estCr(credits)} cr · ${fmtInt(requests)} req`))
  return chip
}

function emptyNote(text: string): HTMLElement {
  return el('div', 'empty-note subtle xs', text)
}

function segmented<T extends string | number>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onPick: (v: T) => void,
  aria: string
): HTMLElement {
  const wrap = el('div', 'seg')
  wrap.setAttribute('role', 'group')
  wrap.setAttribute('aria-label', aria)
  for (const o of options) {
    const b = wrap.appendChild(el('button', `seg-btn${o.value === current ? ' on' : ''}`, o.label))
    b.setAttribute('type', 'button')
    b.setAttribute('aria-pressed', String(o.value === current))
    b.addEventListener('click', () => onPick(o.value))
  }
  return wrap
}

const fmtDays = (d: number): string =>
  d >= 10 ? `${Math.round(d)}d` : d >= 1 ? `${d.toFixed(1)}d` : `${Math.max(1, Math.round(d * 24))}h`

/**
 * The best readable name for a session row, in priority order: the plugin's
 * recorded title, the host title (for the active/known session), the directory
 * basename, then the raw session id (shown muted-mono).
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

/** Direct chats live under OpenChamber's own chats store, which is not a project. */
function projectDir(s: SessionUsage): string | null {
  const dir = s.directory
  if (!dir || /[/\\]openchamber[/\\]chats[/\\]/i.test(dir)) return null
  return dir
}

// ── 1. account hero ───────────────────────────────────────────────────────────

function renderAccountChips(parent: HTMLElement, c: Ctx): void {
  const accounts = c.file.accounts
  if (accounts.length < 2) return
  const row = parent.appendChild(el('div', 'chips'))
  row.setAttribute('role', 'tablist')
  row.setAttribute('aria-label', 'Kiro account')
  accounts.forEach((a, i) => {
    const on = a.id === c.acc.id
    const chip = row.appendChild(el('button', `chip${on ? ' on' : ''}`))
    chip.setAttribute('type', 'button')
    chip.setAttribute('role', 'tab')
    chip.setAttribute('aria-selected', String(on))
    const left = Math.max(0, a.limit - a.used)
    const t = toneFor(a.pct, left)
    const dot = chip.appendChild(el('span', 'dot'))
    dot.style.background = toneVar(t)
    chip.appendChild(el('span', 'chip-name', a.email.split('@')[0]))
    chip.appendChild(el('span', 'mono xs subtle', `${a.pct}%`))
    chip.addEventListener('click', () => {
      accountIdx = i
      repaint()
    })
  })
}

function renderHero(parent: HTMLElement, c: Ctx): void {
  const { acc, proj, burn, now } = c
  const card = parent.appendChild(el('section', 'sec hero'))

  const hasLimit = Number.isFinite(acc.limit) && acc.limit > 0 && Number.isFinite(acc.used)
  const pct = hasLimit ? (Number.isFinite(acc.pct) ? acc.pct : Math.round((acc.used / acc.limit) * 100)) : null
  const tone: Tone = pct != null ? toneFor(pct, proj.remaining) : 'success'

  const head = card.appendChild(el('div', 'acc-head'))
  head.appendChild(el('span', 'avatar', (acc.email[0] || '?').toUpperCase()))
  head.appendChild(el('span', 'acc-email', acc.email))
  if (!acc.isHealthy) head.appendChild(el('span', 'pill pill-error', 'unhealthy'))
  head.appendChild(el('span', 'pill mono', acc.region))

  const body = card.appendChild(el('div', 'acc-body'))
  if (pct != null) body.appendChild(ring(pct, tone))
  else body.appendChild(el('div', 'ring-nr')).appendChild(notReported())

  const figures = body.appendChild(el('div', 'acc-figures'))
  const left = figures.appendChild(el('div'))
  if (hasLimit) {
    left.appendChild(el('span', 'mono big', fmt(proj.remaining)))
    left.appendChild(el('span', 'muted xs', ' credits left'))
    figures.appendChild(el('div', 'xs subtle mono', `${fmt(acc.used)} of ${fmtInt(acc.limit)} used`))
  } else {
    left.appendChild(notReported())
    left.appendChild(el('span', 'muted xs', ' credits left'))
  }

  figures.appendChild(el('div', 'hr'))

  const rateRow = figures.appendChild(el('div', 'fig-row'))
  rateRow.appendChild(icon(ICON_BOLT))
  const rate = proj.recentPace ?? proj.periodPace
  if (rate) {
    const txt = rateRow.appendChild(el('span', 'mono xs'))
    txt.textContent = `≈ ${fmt(rate.perWorkday, 0)} cr/working day`
    txt.textContent = ''
    txt.appendChild(el('span', 'rate-val', `≈ ${fmt(rate.perWorkday, 0)} cr/workday`))
    const basis = !proj.recentPace
      ? 'month avg'
      : burn && burn.spanMs / DAY_MS >= 6.5
        ? 'last 7 days'
        : `last ${Math.max(1, Math.round((burn?.spanMs ?? 0) / DAY_MS))}d`
    txt.appendChild(el('span', 'subtle rate-basis', basis))
    // Exact when it comes from Kiro's counter (recent) or from `used` itself (month average).
    const exact = !proj.recentPace || burn?.exact === true
    if (!exact) rateRow.appendChild(estTag())
    rateRow.appendChild(
      infoIcon(
        !proj.recentPace
          ? 'Credits used this period (exact, Kiro’s counter) divided by the working days (Monday to Friday) so far. Used until Kiro’s counter has been recorded for 3 days. The period start is assumed to be one month before the reset.'
          : burn?.exact
            ? 'How much Kiro’s own credit counter rose over the recorded span, divided by the working days (Monday to Friday) in it. Exact for this account, from every machine that uses it.'
            : 'Credits the plugin measured for the recent window, divided by the working days (Monday to Friday) it spans.'
      )
    )
  } else {
    rateRow.appendChild(el('span', 'xs subtle', 'Usage rate available after your first message'))
  }

  // Period: day N of M, plus credits-used vs time-elapsed so overspending shows.
  if (proj.period && pct != null) {
    const p = proj.period
    const block = card.appendChild(el('div', 'period'))
    const line = block.appendChild(el('div', 'period-line'))
    const approx = p.approx ? '≈ ' : ''
    line.appendChild(el('span', 'mono xs', `${approx}Day ${p.dayNo} of ${Math.round(p.lenDays)}`))
    if (acc.resetAt) {
      line.appendChild(
        el(
          'span',
          'mono xs subtle',
          proj.resetOverdue ? 'reset due' : `resets in ${fmtSpan(acc.resetAt - now)} · ${fmtShortDate(acc.resetAt)}`
        )
      )
    }
    const track = block.appendChild(el('div', 'pbar'))
    track.setAttribute('role', 'img')
    track.setAttribute(
      'aria-label',
      `${pct}% of credits used, ${Math.round(p.timePct)}% of the period elapsed`
    )
    const fill = track.appendChild(el('div', 'pbar-fill'))
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`
    fill.style.background = toneVar(tone)
    const mark = track.appendChild(el('div', 'pbar-mark'))
    mark.style.left = `${Math.min(100, Math.max(0, p.timePct))}%`
    block.appendChild(
      el('div', 'xs subtle', `${pct}% of credits used · ${Math.round(p.timePct)}% of the period elapsed`)
    )
  } else if (acc.resetAt) {
    const row = card.appendChild(el('div', 'fig-row'))
    row.appendChild(icon(ICON_CLOCK))
    row.appendChild(
      el('span', 'mono xs subtle', proj.resetOverdue ? 'reset due' : `resets in ${fmtSpan(acc.resetAt - now)}`)
    )
  } else {
    const row = card.appendChild(el('div', 'fig-row'))
    row.appendChild(icon(ICON_CLOCK))
    row.appendChild(el('span', 'xs subtle', 'Reset date '))
    row.appendChild(notReported())
  }

  renderProjection(card, c, pct)

  // Details toggle + collapsible plan/reset/overage
  const toggle = card.appendChild(el('button', 'details-toggle'))
  toggle.setAttribute('type', 'button')
  toggle.setAttribute('aria-expanded', String(detailsOpen))
  toggle.appendChild(el('span', undefined, 'Details'))
  const chev = toggle.appendChild(icon(ICON_CHEVRON_DOWN, 0.6))
  chev.style.transform = detailsOpen ? 'rotate(180deg)' : 'rotate(0deg)'
  toggle.addEventListener('click', () => {
    detailsOpen = !detailsOpen
    void host.storage.set(DETAILS_OPEN_KEY, detailsOpen).catch(() => {})
    repaint()
  })

  if (detailsOpen) {
    const d = card.appendChild(el('div', 'details'))
    d.appendChild(detailRow('Plan', acc.plan))
    if (acc.resetAt) {
      d.appendChild(
        detailRow('Resets', `${fmtShortDate(acc.resetAt)} · ${proj.resetOverdue ? 'due' : fmtSpan(acc.resetAt - now) + ' left'}`)
      )
    } else d.appendChild(detailRow('Resets', undefined))
    if (proj.period) {
      d.appendChild(
        detailRow(
          proj.period.approx ? 'Period start (≈)' : 'Period start',
          `${fmtShortDate(proj.period.startMs)} · ${Math.floor(proj.period.daysUsed)}d used`
        )
      )
    }
    if (acc.overageStatus) {
      const rate = acc.overageRate != null ? `$${fmt(acc.overageRate, 2)}/credit` : ''
      const cap = acc.overageCap != null ? ` · cap ${fmtInt(acc.overageCap)}` : ''
      d.appendChild(
        detailRow('Overage', acc.overageStatus === 'DISABLED' ? 'disabled' : `${rate}${cap}`.trim() || acc.overageStatus)
      )
    } else d.appendChild(detailRow('Overage', undefined))
    if (acc.currentOverages) d.appendChild(detailRow('Overages spent', fmt(acc.currentOverages)))
    d.appendChild(detailRow('Synced', acc.updatedAt ? fmtAgo(acc.updatedAt, now) : undefined))
  }
}

function detailRow(label: string, value: string | undefined): HTMLElement {
  const row = el('div', 'detail-row')
  row.appendChild(el('span', 'subtle xs', label))
  if (value == null || value === '') row.appendChild(notReported())
  else row.appendChild(el('span', 'mono xs muted', value))
  return row
}

/**
 * "Will I make it to the reset?" Credits left and the reset date are exact and give a budget per
 * working day. The pace is judged two ways (this month's average, and the last 7 days) and the
 * card says so when they disagree, instead of picking one and sounding sure.
 */
function renderProjection(card: HTMLElement, c: Ctx, pct: number | null): void {
  const { proj, acc, now } = c
  const box = card.appendChild(el('div', 'proj'))
  let tone: Tone | null = null
  const text = el('div', 'proj-text')
  const main = text.appendChild(el('div', 'proj-main'))
  const sub = text.appendChild(el('div', 'proj-sub xs'))
  const cr = (n: number): string => `${fmt(n, 0)} cr`
  const { periodPace: pp, recentPace: rp, budgetPerWorkday: budget } = proj
  const known = [pp, rp].filter((p): p is PaceView => p != null)

  if (pct == null) {
    main.appendChild(el('span', undefined, 'Projection '))
    main.appendChild(notReported())
  } else if (proj.resetOverdue) {
    main.textContent = 'Reset date has passed'
    sub.textContent = 'Waiting for the next usage sync.'
  } else if (!proj.verdict || budget == null) {
    const only = rp ?? pp
    if (only?.runOutAt != null) {
      main.textContent = `Credits last ~${fmtDays((only.runOutAt - now) / DAY_MS)} (${fmtApproxDate(only.runOutAt)})`
      sub.textContent = 'Reset date not reported, so no comparison with the reset.'
    } else {
      main.textContent = 'Projection needs a measured burn'
      sub.textContent = 'Available after your first message this period.'
    }
  } else if (proj.verdict === 'ok') {
    tone = 'success'
    const spare = Math.min(...known.map((p) => p.spare ?? Infinity))
    main.textContent = `Lasts to the reset · ~${fmt(spare, 0)} cr to spare`
    sub.textContent = `You can spend ~${cr(budget)} per working day · now ≈ ${cr((rp ?? pp)!.perWorkday)}`
  } else if (proj.verdict === 'maybe' && pp && rp) {
    tone = 'warning'
    main.textContent = `Could run out ${fmtApproxDate(rp.runOutAt!)} if last week's pace holds`
    sub.textContent = `This month's average (≈ ${cr(pp.perWorkday)}/day) leaves ~${fmt(pp.spare ?? 0, 0)} cr spare, the last 7 days (≈ ${cr(rp.perWorkday)}/day) do not. You can spend ~${cr(budget)} per working day.`
  } else {
    // Neither pace makes it: quote the less pessimistic one, so the warning is never overstated.
    const later = [...known].sort((x, y) => (y.runOutAt ?? 0) - (x.runOutAt ?? 0))[0]!
    const days = ((later.runOutAt ?? now) - now) / DAY_MS
    tone = pct >= 85 ? 'error' : 'warning'
    main.textContent = `Runs out in ~${fmtDays(days)} (${fmtApproxDate(later.runOutAt!)})`
    sub.textContent = `${fmtDays((proj.daysToReset ?? 0) - days)} before the reset · ~${fmt(-(later.spare ?? 0), 0)} cr short · budget ~${cr(budget)} per working day`
  }

  if (tone) {
    box.classList.add(`proj-${tone}`)
    box.appendChild(icon(tone === 'success' ? ICON_BOLT : ICON_ALERT, 1))
  }
  box.appendChild(text)
  if (tone) {
    const tagWrap = box.appendChild(el('span', 'proj-tags'))
    tagWrap.appendChild(estTag())
    tagWrap.appendChild(
      infoIcon(
        `Credits left (exact) and the reset date (${acc.resetAt ? fmtShortDate(acc.resetAt) : 'n/a'}, exact) give a budget per working day. Your pace is compared two ways: this month's average (credits used ÷ working days so far, exact) and the last 7 days (estimated). A working day is Monday to Friday, a 40-hour week; weekends count zero. The period start is assumed to be one month before the reset. The result depends on whether your recent pace continues.`
      )
    )
  }
}

// ── 2. key figures ────────────────────────────────────────────────────────────

function renderTiles(parent: HTMLElement, c: Ctx): void {
  const { file, acc } = c
  const grid = parent.appendChild(el('div', 'tiles'))
  const win = file.burn?.find((b) => b.accountId === acc.id)?.windowDays ?? file.tools?.windowDays ?? null
  const span = win != null ? `${win}d` : 'window'

  // burn[].requests counts every session active in the window, per account, and is exact.
  const req = requests7d(acc.id, file.burn)
  grid.appendChild(
    tile(`Requests · ${span}`, req != null ? fmtInt(req) : null, file.accounts.length > 1 ? 'this account' : undefined)
  )

  // Credits and requests of the same sessions: only those whose credits are fully measured.
  const cpr = creditsPerRequest(file, acc.id)
  const cprTile = grid.appendChild(
    tile(
      'Credits / request',
      cpr ? (cpr.measured ? fmt(cpr.value, 2) : estCr(cpr.value, 2)) : null,
      cpr
        ? cpr.measured && typeof file.meteredSince === 'number'
          ? `since ${fmtShortDate(file.meteredSince)}`
          : 'average'
        : 'needs 50 metered requests',
      { est: !cpr?.measured }
    )
  )
  cprTile.title =
    'Average credits per request on this account, over sessions begun since the plugin measures credits per response. Older sessions are left out because their credits were overcounted. A rising number means heavier requests: bigger context or a costlier model.'

}

// ── 3. credits per day ────────────────────────────────────────────────────────

function renderTrend(parent: HTMLElement, c: Ctx): void {
  // The plugin does not record per-day totals: show nothing rather than an empty section.
  if (!c.file.daily?.length) return
  const { file, acc, now } = c
  const series = dailySeries(file.daily, acc.id, now, 14)
  const right = segmented<Range>(
    [
      { value: 7, label: '7d' },
      { value: 14, label: '14d' }
    ],
    rangeDays,
    (v) => {
      rangeDays = v
      savePrefs()
      repaint()
    },
    'Range'
  )
  const box = section(parent, 'Credits per day', {
    est: true,
    src: 'Kiro',
    info:
      'Estimated: Kiro reports credits only as an account total, so the plugin apportions each change in that total across the requests made that day. Hatched bars are days before the plugin started recording, which are not reported, not zero.',
    right
  })

  if (!series) {
    box.appendChild(emptyNote('Daily history not reported: the plugin does not record per-day totals yet.'))
    const burn = c.burn
    if (burn) box.appendChild(el('div', 'xs subtle mono', `Recent burn ≈ ${fmt(burn.perDay, 1)} cr/day (est.)`))
    return
  }

  const shown = series.slice(-rangeDays)
  const stats = trendStats(shown)
  const full = trendStats(series)
  const avg = stats ? stats.avg : null

  const chart = barChart(
    shown.map((p) => ({
      value: p.credits,
      today: p.today,
      aria: `${fmtDay(p.ms)}: ${p.credits == null ? 'not reported' : `about ${fmt(p.credits, 1)} credits, estimated`}`
    })),
    avg,
    (i) => showDay(i)
  )
  box.appendChild(chart.node)

  const axis = box.appendChild(el('div', 'axis xs subtle'))
  axis.appendChild(el('span', undefined, fmtShortDate(shown[0]!.ms)))
  axis.appendChild(el('span', undefined, 'today'))

  const readout = box.appendChild(el('div', 'readout mono xs'))
  const summary = () => {
    readout.replaceChildren()
    if (!stats) {
      readout.appendChild(notReported())
      return
    }
    readout.appendChild(el('span', undefined, `${estCr(stats.total)} cr`))
    readout.appendChild(el('span', 'subtle', ` in ${rangeDays}d · avg ${estCr(stats.avg)}/day`))
    if (rangeDays === 14 && full?.weekDelta != null) {
      const up = full.weekDelta > 0
      const d = readout.appendChild(
        el('span', undefined, `  ${up ? '▲' : '▼'} ${Math.abs(Math.round(full.weekDelta))}% vs prev week`)
      )
      d.style.color = up ? 'var(--oc-warning-text)' : 'var(--oc-success-text)'
    }
  }
  const showDay = (i: number) => {
    const p = shown[i]
    if (!p) return
    readout.replaceChildren()
    readout.appendChild(el('span', 'subtle', `${fmtDay(p.ms)}  `))
    if (p.credits == null) readout.appendChild(notReported())
    else {
      readout.appendChild(el('span', undefined, `${estCr(p.credits)} cr`))
      readout.appendChild(
        el('span', 'subtle', ` · ${p.requests != null ? fmtInt(p.requests) : '?'} req`)
      )
      if (p.toolCalls != null) readout.appendChild(el('span', 'subtle', ` · ${fmtInt(p.toolCalls)} tools`))
    }
  }
  chart.node.addEventListener('mouseleave', () => {
    summary()
    chart.select(-1)
  })
  summary()
}

// ── 4. tool usage ─────────────────────────────────────────────────────────────

/**
 * A tool name in a tool list. `execute` gets a note: a Code Mode script is one call to OpenCode,
 * and the tool calls it makes inside are not recorded separately.
 *
 * @param parent the row head to append to
 * @param name the tool name
 */
function toolName(parent: HTMLElement, name: string): void {
  const n = parent.appendChild(el('span', 'mono trow-name', name))
  if (name === 'execute') {
    n.appendChild(
      infoIcon('One Code Mode script counts as one call. The tool calls it makes inside are not recorded separately, so the real number of tool calls is higher.')
    )
  }
}

function renderTools(parent: HTMLElement, c: Ctx): void {
  const agg = aggregateTools(c.file)
  const box = section(parent, 'Tool usage', {
    info: 'Tool calls counted from OpenCode’s history. Kiro reports no cost per tool call, so the ranking is by number of calls.'
  })
  if (!agg) {
    box.appendChild(emptyNote('Tool usage not reported: the plugin does not store tool calls yet.'))
    return
  }

  const scope =
    agg.source === 'plugin'
      ? `${fmtInt(agg.total)} calls · last ${agg.windowDays}d`
      : `${fmtInt(agg.total)} calls · ${agg.sessionCount} recent session${agg.sessionCount === 1 ? '' : 's'}`
  box.appendChild(el('div', 'xs subtle mono', scope))

  const LIMIT = 8
  const items = showAllTools ? agg.items : agg.items.slice(0, LIMIT)
  const max = Math.max(1, ...agg.items.map((t) => t.count))
  const list = box.appendChild(el('div', 'tools'))
  for (const t of items) {
    const row = list.appendChild(el('div', 'trow'))
    const top = row.appendChild(el('div', 'trow-top'))
    toolName(top, t.name)
    top.appendChild(el('span', 'mono xs trow-nums', `×${fmtInt(t.count)}`))
    row.appendChild(hbar(t.count / max, 'var(--oc-info)'))
  }
  if (agg.items.length > LIMIT) {
    const more = box.appendChild(
      el('button', 'linkbtn', showAllTools ? 'Show fewer' : `Show all ${agg.items.length} tools`)
    )
    more.setAttribute('type', 'button')
    more.addEventListener('click', () => {
      showAllTools = !showAllTools
      savePrefs()
      repaint()
    })
  }

}

// ── tokens ────────────────────────────────────────────────────────────────────

const TOKEN_PARTS: Array<{ key: keyof TokenCounts; label: string; color: string; hint: string }> = [
  { key: 'uncachedInputTokens', label: 'Input', color: 'var(--oc-primary)', hint: 'derived from Kiro’s context %' },
  { key: 'cacheReadTokens', label: 'Cache read', color: 'var(--oc-info)', hint: 'repeated context from cache, the cheap part' },
  { key: 'cacheWriteTokens', label: 'Cache write', color: 'var(--oc-warning)', hint: 'context written to the cache' },
  { key: 'outputTokens', label: 'Output', color: 'var(--oc-success)', hint: 'generated tokens' }
]

/** Stacked bar + legend for exact token counts, cache-read shown on its own. */
function tokenBreakdown(box: HTMLElement, t: TokenCounts, requests: number | null): void {
  const total = promptTokens(t) + t.outputTokens
  if (t.reportedRequests <= 0 || total <= 0) {
    const n = box.appendChild(el('div', 'xs subtle'))
    n.appendChild(el('span', undefined, 'Tokens '))
    n.appendChild(notReported())
    return
  }
  const stack = box.appendChild(el('div', 'stack'))
  stack.setAttribute('role', 'img')
  stack.setAttribute('aria-label', 'Token split: input, cache read, cache write, output')
  for (const part of TOKEN_PARTS) {
    const v = t[part.key] as number
    if (v <= 0) continue
    const seg = stack.appendChild(el('i'))
    seg.style.width = `${(v / total) * 100}%`
    seg.style.background = part.color
  }
  const legend = box.appendChild(el('div', 'legend'))
  const noCache = t.cacheReadTokens <= 0 && t.cacheWriteTokens <= 0
  for (const part of TOKEN_PARTS) {
    const v = t[part.key] as number
    // Kiro does not report a cache split for most models: an all-zero cache row is
    // noise, so say so once below instead of drawing "0 · 0%".
    if (noCache && (part.key === 'cacheReadTokens' || part.key === 'cacheWriteTokens')) continue
    const row = legend.appendChild(el('div', 'legend-row'))
    const dot = row.appendChild(el('span', 'dot'))
    dot.style.background = part.color
    row.appendChild(el('span', 'legend-label xs', part.label))
    row.appendChild(el('span', 'mono xs', `~${fmtCompact(v)}`))
    row.appendChild(el('span', 'mono xs subtle legend-pct', `${Math.round((v / total) * 100)}%`))
  }
  // Kiro sends no cache figures (the plugin fills in 0), so an all-zero cache split is hidden
  // without comment. reportedRequests is every finished message, so it carries no "floor" note.
  const prompt = promptTokens(t)
  if (!noCache && prompt > 0 && t.cacheReadTokens > 0) {
    box.appendChild(
      el('div', 'xs subtle', `${Math.round((t.cacheReadTokens / prompt) * 100)}% of prompt tokens were cache reads`)
    )
  }
  void requests
}

/** Why sessions begun before per-response metering read high. */
const PRE_METERING_INFO =
  'Sessions begun before per-response metering carry credits apportioned from the account counter. Several OpenCode instances could book the same rise, so those run high (measured roughly 1.4 to 1.7 times the counter). Newer sessions are metered per response.'

/** What the token numbers are, since Kiro reports none itself. */
const TOKENS_INFO =
  'Estimated by the plugin: Kiro sends no token counts. Output is about 4 characters per token of the reply, reasoning and tool input. Input is Kiro’s context percentage times the model window the plugin assumes (1M for auto), so it is off if auto routes to a model with another window. Kiro bills credits per request, so tokens do not convert to credits.'

function renderTokens(parent: HTMLElement, c: Ctx): void {
  const box = section(parent, 'Tokens', {
    est: true,
    src: 'plugin',
    info: TOKENS_INFO
  })
  const sum = tokenSummary(c.file, accountsInUse(c.file))
  if (!sum) {
    box.appendChild(emptyNote('Tokens not reported: the plugin has not written token totals yet.'))
    return
  }
  box.appendChild(
    el(
      'div',
      'xs subtle mono',
      sum.scope === 'window' ? `last ${sum.windowDays}d` : `${sum.sessions} recent session${sum.sessions === 1 ? '' : 's'}`
    )
  )
  tokenBreakdown(box, sum.counts, sum.requests)
}

// ── 5. per-account overview ───────────────────────────────────────────────────

function renderAccounts(parent: HTMLElement, c: Ctx): void {
  if (c.file.accounts.length < 2) return
  const box = section(parent, 'Accounts', {
    info: 'Credits left and requests are exact; burn per day is an estimate.'
  })
  const list = box.appendChild(el('div', 'acct-list'))
  c.file.accounts.forEach((a, i) => {
    const left = Math.max(0, a.limit - a.used)
    const t = toneFor(a.pct, left)
    const b = list.appendChild(el('button', `acct-row${a.id === c.acc.id ? ' on' : ''}`))
    b.setAttribute('type', 'button')
    b.addEventListener('click', () => {
      accountIdx = i
      repaint()
    })
    b.appendChild(ring(a.pct, t, 34, 9, false))
    const mid = b.appendChild(el('div', 'acct-mid'))
    mid.appendChild(el('div', 'acct-name', a.email))
    const meta = mid.appendChild(el('div', 'xs subtle mono'))
    meta.appendChild(el('span', undefined, `${fmt(left, 0)} left`))
    const burn = recentBurn(c.file, a, c.now)
    meta.appendChild(el('span', undefined, burn ? ` · ≈${fmt(burn.perDay, 0)} cr/day` : ' · '))
    if (!burn) meta.appendChild(notReported())
    const req = requests7d(a.id, c.file.burn)
    const right = b.appendChild(el('div', 'acct-req mono xs'))
    if (req != null) {
      right.appendChild(el('span', undefined, fmtInt(req)))
      right.appendChild(el('span', 'subtle', ' req · 7d'))
    } else {
      right.appendChild(notReported())
    }
  })
}

// ── 6. sessions ───────────────────────────────────────────────────────────────

const SORT_LABEL: Record<SessionSort, string> = {
  cost: 'Cost',
  recent: 'Recent',
  requests: 'Requests',
  tokens: 'Tokens'
}

function renderSessions(parent: HTMLElement, c: Ctx): void {
  const sessions = c.file.sessions
  const total = c.file.sessionsTotal
  const box = section(parent, 'Sessions', {
    est: true,
    src: 'plugin',
    info:
      `Credits per session come from the plugin, not from Kiro: Kiro only reports an account total. ${PRE_METERING_INFO} Requests, tool calls and turn mix are exact.`,
    right: el('span', 'xs subtle mono', total != null && total > sessions.length ? `${sessions.length} of ${fmtInt(total)}` : '')
  })

  if (!sessions.length) {
    box.appendChild(emptyNote('No sessions recorded yet. They appear after your first message.'))
    return
  }

  box.appendChild(
    segmented<SessionSort>(
      SORTS.map((s) => ({ value: s, label: SORT_LABEL[s] })),
      sortMode,
      (v) => {
        sortMode = v
        savePrefs()
        repaint()
      },
      'Sort sessions'
    )
  )

  const sorted = sortSessions(sessions, sortMode)
  const maxCredits = Math.max(1e-9, ...sessions.map((s) => s.estCredits))
  // Only metered sessions compete for "priciest": the overcounted old ones would always win.
  const metered = sessions.filter((s) => !isPreMetering(c.file, s))
  const priciest = metered.length > 2 ? metered.reduce((m, s) => (s.estCredits > m.estCredits ? s : m)) : null
  const preCount = sessions.length - metered.length
  if (preCount > 0 && typeof c.file.meteredSince === 'number') {
    const note = box.appendChild(el('div', 'xs subtle pre-note'))
    note.textContent = `${preCount} of ${sessions.length} began before metering (${fmtShortDate(c.file.meteredSince)}). Their credits, dimmed, likely run high. `
    note.appendChild(infoIcon(PRE_METERING_INFO))
  }
  const list = box.appendChild(el('div', 'sessions'))
  const SESSION_LIMIT = 15
  const shown = showAllSessions ? sorted : sorted.slice(0, SESSION_LIMIT)
  for (const s of shown) renderSessionRow(list, s, c, maxCredits, s === priciest)
  if (sorted.length > SESSION_LIMIT) {
    const more = box.appendChild(
      el('button', 'linkbtn', showAllSessions ? 'Show fewer' : `Show all ${sorted.length} sessions`)
    )
    more.setAttribute('type', 'button')
    more.addEventListener('click', () => {
      showAllSessions = !showAllSessions
      repaint()
    })
  }
}

function renderSessionRow(
  list: HTMLElement,
  s: SessionUsage,
  c: Ctx,
  maxCredits: number,
  isPriciest: boolean
): void {
  const isCurrent = currentSessionId != null && s.sessionId === currentSessionId
  const name = sessionName(s, isCurrent)
  const row = list.appendChild(el('button', `srow${isCurrent ? ' current' : ''}`))
  row.setAttribute('type', 'button')
  row.addEventListener('click', () => {
    detailId = s.sessionId
    repaint(true)
  })

  const top = row.appendChild(el('div', 'srow-top'))
  const left = top.appendChild(el('div', 'srow-name'))
  left.appendChild(el('span', name.isId ? 'srow-title mono muted' : 'srow-title', name.text))
  if (isCurrent) left.appendChild(el('span', 'mono now', 'now'))
  if (isPriciest) left.appendChild(el('span', 'badge-warn', 'priciest'))
  const pre = isPreMetering(c.file, s)
  const fig = top.appendChild(el('span', 'srow-figures mono'))
  const cr = fig.appendChild(el('span', pre ? 'srow-credits pre' : 'srow-credits', estCr(s.estCredits)))
  if (pre) cr.title = 'Pre-metering: likely too high'
  fig.appendChild(el('span', 'subtle', ' cr'))

  // A session that ran on several accounts shows its bar split by account.
  const multi = s.accounts && s.accounts.length > 1 ? s.accounts : null
  if (multi) {
    row.appendChild(
      segBar(
        multi.map((a) => ({ value: a.estCredits, color: acctInfo(c, a.accountId).color })),
        s.estCredits / maxCredits
      )
    )
  } else {
    row.appendChild(hbar(s.estCredits / maxCredits, isPriciest ? 'var(--oc-warning)' : 'var(--oc-primary)'))
  }

  // One line: project, requests, age. Tools, turns and context live in the drill-down.
  const meta = row.appendChild(el('div', 'srow-meta mono xs subtle'))
  const dir = projectDir(s)
  const project = dir ? dir.split('/').filter(Boolean).pop() : undefined
  if (project && project !== name.text) {
    meta.appendChild(el('span', 'srow-proj', project)).title = dir!
    meta.appendChild(el('span', undefined, '\u00a0·\u00a0'))
  }
  meta.appendChild(el('span', undefined, `${fmtInt(s.requests)} req · ${fmtAgo(s.lastUsed, c.now)}`))
  const turns = turnSplit(s)
  if (turns && turns.error > 0) {
    meta.appendChild(el('span', undefined, '\u00a0·\u00a0'))
    const e = meta.appendChild(el('span', undefined, `${fmtInt(turns.error)} failed`))
    e.style.color = toneText('error')
  }
  if (multi) {
    const legend = row.appendChild(el('div', 'srow-accts'))
    for (const a of [...multi].sort((x, y) => y.estCredits - x.estCredits)) {
      legend.appendChild(acctChip(acctInfo(c, a.accountId), a.estCredits, a.requests))
    }
  }
}

// ── 7. session drill-down ─────────────────────────────────────────────────────

/** Stacked bar plus legend. `total` is the sum the parts add up to; `fmtVal` formats each part's value. */
function mixBar(
  box: HTMLElement,
  parts: Array<{ label: string; v: number; color: string }>,
  total: number,
  fmtVal: (v: number) => string,
  aria: string,
  approx = false
): void {
  const stack = box.appendChild(el('div', 'stack'))
  stack.setAttribute('role', 'img')
  stack.setAttribute('aria-label', aria)
  for (const part of parts) {
    if (part.v <= 0) continue
    const seg = stack.appendChild(el('i'))
    seg.style.width = `${(part.v / total) * 100}%`
    seg.style.background = part.color
  }
  const legend = box.appendChild(el('div', 'legend'))
  for (const part of parts) {
    const row = legend.appendChild(el('div', 'legend-row'))
    const dot = row.appendChild(el('span', 'dot'))
    dot.style.background = part.color
    row.appendChild(el('span', 'legend-label xs', part.label))
    row.appendChild(el('span', 'mono xs', fmtVal(part.v)))
    row.appendChild(el('span', 'mono xs subtle legend-pct', `${approx ? '~' : ''}${Math.round((part.v / total) * 100)}%`))
  }
}


function renderDetail(parent: HTMLElement, c: Ctx, s: SessionUsage): void {
  const isCurrent = s.sessionId === currentSessionId
  const name = sessionName(s, isCurrent)

  const back = parent.appendChild(el('button', 'back'))
  back.setAttribute('type', 'button')
  back.appendChild(icon(ICON_ARROW_LEFT, 0.9))
  back.appendChild(el('span', undefined, 'All sessions'))
  back.addEventListener('click', () => {
    detailId = null
    repaint(true)
  })

  const head = parent.appendChild(el('section', 'sec'))
  const title = head.appendChild(el('div', 'd-title'))
  title.appendChild(el('span', name.isId ? 'mono muted' : 'd-name', name.text))
  if (isCurrent) title.appendChild(el('span', 'mono now', 'now'))
  const dir = projectDir(s)
  if (dir) head.appendChild(el('div', 'mono xs subtle d-path', dir))

  const span = Math.max(0, s.lastUsed - s.firstUsed)
  const tools = toolCallsOf(s)
  const grid = head.appendChild(el('div', 'tiles'))
  const pre = isPreMetering(c.file, s)
  grid.appendChild(
    tile('Credits', estCr(s.estCredits), pre
        ? 'pre-metering, likely too high'
        : c.file.creditsSource === 'metered'
          ? 'measured per response'
          : 'share of the account total, by request',
      { est: true }
    )
  )
  grid.appendChild(tile('Requests', fmtInt(s.requests)))
  grid.appendChild(
    tile('Credits / request', s.requests > 0 ? estCr(s.estCredits / s.requests, 2) : null, undefined, { est: true })
  )

  const facts = head.appendChild(el('div', 'details'))
  facts.appendChild(detailRow('Active', `${fmtAgo(s.firstUsed, c.now)} → ${fmtAgo(s.lastUsed, c.now)} · ${fmtDuration(span)}`))

  const turnBox = section(parent, 'What it did', {
    info:
      'Responses of this session and its subagents. A tool turn ends with tool calls, so the agent keeps working; an answer is a plain reply; a failed turn ended in an error.'
  })
  const ts = turnSplit(s)
  if (ts) {
    const parts = [
      { label: 'Tool turns', v: ts.toolUse, color: 'var(--oc-info)' },
      { label: 'Answers', v: ts.answer, color: 'var(--oc-success)' },
      { label: 'Failed', v: ts.error, color: 'var(--oc-error)' }
    ]
    mixBar(turnBox, parts, ts.total, (v) => fmtInt(v), 'Turn split: tool turns and answers')
  } else {
    turnBox.appendChild(notReported())
  }

  const tokBox = section(parent, 'Tokens', { est: true, src: 'plugin', info: TOKENS_INFO })
  if (s.tokens) tokenBreakdown(tokBox, s.tokens, s.requests)
  else tokBox.appendChild(notReported())

  const toolBox = section(parent, 'Tools', {
    right: tools != null ? el('span', 'xs subtle mono', `${fmtInt(tools)} calls`) : undefined
  })
  if (s.tools?.length) {
    const sorted = [...s.tools].sort((a, b) => b.count - a.count)
    const max = Math.max(1, ...sorted.map((t) => t.count))
    const LIMIT = 8
    const open = showAllSessionTools === s.sessionId
    const list = toolBox.appendChild(el('div', 'tools'))
    for (const t of open ? sorted : sorted.slice(0, LIMIT)) {
      const row = list.appendChild(el('div', 'trow'))
      const top = row.appendChild(el('div', 'trow-top'))
      toolName(top, t.name)
      top.appendChild(el('span', 'mono xs trow-nums', `×${fmtInt(t.count)}`))
      row.appendChild(hbar(t.count / max, 'var(--oc-info)'))
    }
    if (sorted.length > LIMIT) {
      const more = toolBox.appendChild(el('button', 'linkbtn', open ? 'Show fewer' : `Show all ${sorted.length} tools`))
      more.setAttribute('type', 'button')
      more.addEventListener('click', () => {
        showAllSessionTools = open ? null : s.sessionId
        repaint()
      })
    }
  } else if (tools != null) {
    const n = toolBox.appendChild(el('div', 'xs subtle'))
    n.appendChild(el('span', undefined, 'Per-tool breakdown: '))
    n.appendChild(notReported())
  } else {
    toolBox.appendChild(notReported())
  }

  // Worth a section whenever the session itself ran on more than one account,
  // even if only one is still signed in: the other's share stays in the totals.
  if (s.accounts && s.accounts.length > 1) {
    const accBox = section(parent, 'Accounts used', {
      est: true,
      info: 'Credits are split per account from that account’s own usage changes.'
    })
    accBox.appendChild(
      segBar(
        s.accounts.map((a) => ({ value: a.estCredits, color: acctInfo(c, a.accountId).color })),
        1
      )
    )
    const list = accBox.appendChild(el('div', 'srow-accts-col'))
    let goneCredits = 0
    for (const a of [...s.accounts].sort((x, y) => y.estCredits - x.estCredits)) {
      const info = acctInfo(c, a.accountId)
      if (info.removed) goneCredits += a.estCredits
      list.appendChild(acctChip(info, a.estCredits, a.requests))
    }
    if (goneCredits > 0) {
      accBox.appendChild(
        el(
          'div',
          'xs subtle',
          `${estCr(goneCredits)} cr ran on an account that is no longer signed in.`
        )
      )
    }
  }

  const actions = parent.appendChild(el('div', 'actions'))
  const open = actions.appendChild(el('button', 'btn primary', 'Open session'))
  open.setAttribute('type', 'button')
  open.addEventListener('click', () => void host.openSession(s.sessionId).catch(() => {}))
  const copy = actions.appendChild(el('button', 'btn', 'Copy session id'))
  copy.setAttribute('type', 'button')
  copy.addEventListener('click', () => {
    void host.writeClipboard(s.sessionId).catch(() => {})
    copy.textContent = 'Copied'
    setTimeout(() => (copy.textContent = 'Copy session id'), 1500)
  })
}

// ── plugin card + freshness ───────────────────────────────────────────────────

function renderPlugin(
  container: HTMLElement,
  installed: string | undefined,
  instances: PluginInstance[],
  hasInsights: boolean
): void {
  // The latest version comes from the plugin in the snapshot (it has real network
  // access), not from a panel-side request that would need a token integration.
  const versions = new Set(instances.map((i) => i.version))
  const split = versions.size > 1
  const known = latestVersion != null && installed != null
  const outdated = !split && known && compareSemver(installed!, latestVersion!) < 0
  const upToDate = !split && known && !outdated

  const card = container.appendChild(el('div', 'plugin-card'))
  const top = card.appendChild(el('div', 'plugin-top'))
  const idcol = top.appendChild(el('span', 'plugin-id'))
  const dot = idcol.appendChild(el('span', 'dot'))
  dot.style.background = outdated || split ? toneVar('warning') : toneVar('success')
  idcol.appendChild(el('span', 'mono plugin-name', PLUGIN_PKG))

  const right = top.appendChild(el('span', 'plugin-right'))
  right.appendChild(el('span', 'mono xs muted', installed ? `v${installed}` : 'version?'))
  const label = split ? 'versions differ' : outdated ? 'update available' : upToDate ? 'up to date' : null
  if (label) {
    const badge = right.appendChild(el('span', 'pill', label))
    if (outdated || split) {
      badge.style.color = toneText('warning')
      badge.style.background = 'color-mix(in srgb, var(--oc-warning) 14%, transparent)'
    }
  }

  if (!hasInsights) {
    const note = card.appendChild(el('div', 'plugin-note col'))
    note.appendChild(
      el('span', 'xs', 'This snapshot has no insight fields yet (requests, tokens, tools, daily trend, context). The plugin has to write them; the field list is in the README.')
    )
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
    note.appendChild(el('span', 'xs', `${versions.size} versions running — update every OpenCode install.`))
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
  const bar = container.appendChild(el('div', 'freshness'))
  const label = bar.appendChild(el('span', 'subtle xs'))
  let staleShown = false
  const tick = () => {
    const age = Date.now() - writtenAt
    label.textContent = `Updated ${fmtSpan(age, true)} ago`
    if (age > STALE_MS && !staleShown) {
      staleShown = true
      const pill = bar.insertBefore(el('span', 'pill', 'cached'), bar.firstChild)
      pill.style.color = toneText('warning')
      pill.style.marginRight = '0.4em'
    }
  }
  tick()
  const ticker = setInterval(tick, 1_000)
  mounted.push({ dispose: () => clearInterval(ticker) })
}

/** A slim notice above the content when the snapshot has not been refreshed lately. */
function renderStaleNotice(parent: HTMLElement, writtenAt: number, now: number): void {
  const age = now - writtenAt
  if (age <= STALE_MS) return
  const very = age > VERY_STALE_MS
  const box = parent.appendChild(el('div', `stale${very ? ' stale-warn' : ''}`))
  box.setAttribute('role', 'status')
  box.appendChild(icon(very ? ICON_ALERT : ICON_CLOCK, 0.95))
  box.appendChild(
    el(
      'span',
      'xs',
      very
        ? `Last reading was ${fmtSpan(age)} ago. Figures may be outdated; start OpenCode with the Kiro plugin to refresh.`
        : `Last reading ${fmtSpan(age)} ago. The plugin syncs after a request, so idle time shows as cached.`
    )
  )
}

// ── missing-file / waiting state ──────────────────────────────────────────────

/**
 * What to show when kiro-usage.json is absent. A 2.11.0+ plugin writes it during
 * init, so a missing file almost always means an older plugin, occasionally that
 * OpenCode is still starting; the poll repaints on its own once the file lands.
 */
function renderMissingFile(): void {
  mounted.push(
    mountBanner(root, {
      tone: 'warning',
      title: 'Waiting for the Kiro plugin',
      body: `Usage tracking needs ${PLUGIN_PKG} v${MIN_SUPPORTED_VERSION} or newer. If OpenCode just started, this fills in within a few seconds; otherwise update the plugin.`,
      action: {
        label: 'Copy update command',
        onClick: () => void host.writeClipboard(`npm install -g ${PLUGIN_PKG}@latest`).catch(() => {})
      }
    })
  )
}

// ── data read + paint ─────────────────────────────────────────────────────────

let lastFileKey = ''

/**
 * Read every candidate location and use the freshest snapshot.
 *
 * More than one can exist at once: a plugin run with XDG_CONFIG_HOME=~/.servoy
 * writes there, while an earlier run (or another OpenCode install) left a file in
 * ~/.config. Taking the first that exists would show a stale one, so all are read
 * and the highest `writtenAt` wins. The files are small and read once per poll.
 *
 * A missing file is normal. A file that cannot be read or parsed is skipped when
 * another candidate works, and only reported when none does.
 */
async function readUsageFile(): Promise<UsageFile> {
  const results = await Promise.all(
    USAGE_FILES.map(async (path) => {
      try {
        const { content } = await host.readFile(path)
        return { ok: true as const, file: JSON.parse(content) as UsageFile }
      } catch (error) {
        return { ok: false as const, error }
      }
    })
  )

  let best: UsageFile | null = null
  for (const r of results) {
    if (!r.ok) continue
    if (!best || (r.file.writtenAt ?? 0) > (best.writtenAt ?? 0)) best = r.file
  }
  if (best) return best

  // Nothing readable. Prefer a real error over NOT_FOUND so a broken file is not
  // mistaken for "plugin not installed".
  const failures = results.flatMap((r) => (r.ok ? [] : [r.error]))
  const real = failures.find((e) => !(e instanceof HostRequestError && e.code === 'NOT_FOUND'))
  throw real ?? failures[0] ?? new Error('No usage file candidates')
}

// Serialise paints. onReady, onSession and the poll can all fire within the same
// tick on a cold start; overlapping runs raced on lastFileKey and on clear()/
// append. A single-slot queue guarantees paints run one at a time.
let painting: Promise<void> | null = null
let repaintQueued = false
function paint(force = false): Promise<void> {
  if (painting) {
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
      renderMissingFile()
    } else {
      const msg = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error)
      mounted.push(mountBanner(root, { tone: 'error', title: 'Could not read usage', body: msg }))
    }
    return
  }

  const now = Date.now()
  latestVersion = typeof file.latestVersion === 'string' ? file.latestVersion : latestVersion
  // Older plugins omit the new fields entirely; normalise so views can rely on arrays.
  file.accounts = Array.isArray(file.accounts) ? file.accounts : []
  file.sessions = Array.isArray(file.sessions) ? file.sessions : []

  // Backfill resetAt before computing the repaint key, so a snapshot that dropped
  // it does not count as a different file (and the projection stays stable).
  for (const acc of file.accounts) {
    if (typeof acc.resetAt === 'number') {
      if (lastResetAt.get(acc.id) !== acc.resetAt) {
        lastResetAt.set(acc.id, acc.resetAt)
        saveResetAt()
      }
    } else {
      const known = lastResetAt.get(acc.id)
      if (known != null) acc.resetAt = known
    }
  }

  const key =
    JSON.stringify(file) +
    `|${detailsOpen}|${accountIdx}|${currentSessionId ?? ''}|${detailId ?? ''}|${sortMode}|${rangeDays}|${showAllTools}|${showAllSessionTools ?? "-"}`
  if (!force && key === lastFileKey) return

  // Keep the scroll position across a repaint so a poll never makes the panel jump.
  const scrollTop = resetScrollNext ? 0 : root.scrollTop
  resetScrollNext = false

  // Render synchronously from here down — no awaits — so the key is only set
  // after #root is fully populated, and clear()+append cannot be interleaved.
  clear()

  if (!file.accounts.length) {
    lastFileKey = key
    mounted.push(mountEmpty(root, { title: 'No Kiro accounts', body: 'Sign in to Kiro in OpenCode first.' }))
    return
  }

  const idx = ((accountIdx % file.accounts.length) + file.accounts.length) % file.accounts.length
  const acc = file.accounts[idx]!
  // A burn[] that is still filling up after the metering switch is not a pace: drop it, so the
  // projection falls back to the exact month average instead of "≈ 11 cr/day, plenty left".
  const burn = recentBurn(file, acc, now)
  const c: Ctx = {
    file,
    now,
    emailById: new Map(file.accounts.map((a) => [a.id, a.email])),
    acc,
    burn,
    proj: projectionFor(acc, burn, now)
  }

  const wrap = root.appendChild(el('div', 'wrap'))
  renderStaleNotice(wrap, file.writtenAt || now, now)

  const detail = detailId ? file.sessions.find((s) => s.sessionId === detailId) : undefined
  if (detailId && !detail) detailId = null // the session aged out of the capped list

  if (detail) {
    const col = wrap.appendChild(el('div', 'col detail'))
    renderDetail(col, c, detail)
  } else {
    const layout = wrap.appendChild(el('div', 'layout'))
    const a = layout.appendChild(el('div', 'col'))
    const b = layout.appendChild(el('div', 'col'))
    renderAccountChips(a, c)
    renderHero(a, c)
    renderTiles(a, c)
    renderTrend(a, c)
    renderTokens(a, c)
    renderAccounts(a, c)
    renderTools(b, c)
    renderSessions(b, c)
  }

  const footer = wrap.appendChild(el('div', 'footer'))
  const hasInsights = hasInsightFields(file)
  renderPlugin(footer, file.pluginVersion, file.pluginInstances ?? [], hasInsights)
  renderFreshness(footer, file.writtenAt || now)

  root.scrollTop = scrollTop
  // Key set only now, after #root is fully populated — never mid-render.
  lastFileKey = key
}

// ── host wiring ───────────────────────────────────────────────────────────────

function injectStyles(): void {
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.appendChild(style)
}

/**
 * Subscribe to every project's sessions and learn their titles.
 *
 * `onSession` only reports the *active* session's title, so subagents showed up
 * as their folder name. `host.onSessions(projectId)` lists ALL sessions with id +
 * title; feeding those into the persistent title cache names every row.
 */
async function trackSessionTitles(): Promise<void> {
  try {
    const projects = await host.listProjects()
    for (const project of projects.projects) {
      await host.onSessions(project.id, (snapshot) => {
        let learned = false
        for (const s of snapshot.sessions) {
          if (s.title && s.title !== s.id) {
            const before = sessionTitleCache.get(s.id)?.title
            rememberSessionTitle(s.id, s.title, s.updatedAt || Date.now())
            if (before !== s.title) learned = true
          }
        }
        if (learned) void paint(true)
      })
    }
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
  void trackSessionTitles()
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

// Escape leaves the drill-down, like the back button.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailId) {
    detailId = null
    repaint(true)
  }
})
