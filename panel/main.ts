import { connectHost, HostRequestError } from '@openchamber/sdk'
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountProgress,
  mountSeparator
} from '@openchamber/sdk/ui'

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

/** A used-credits reading at a point in time, per account, for rate/delta. */
interface Baseline {
  used: number
  at: number
}

const host = connectHost()
const root = document.querySelector('#root') as HTMLElement

let mounted: Array<{ dispose: () => void }> = []
const clear = () => {
  for (const block of mounted) block.dispose()
  mounted = []
  root.innerHTML = ''
}

// Baseline per account, captured the first time the panel sees it, so "used
// since panel opened" and credits/hour survive re-renders.
const baselines = new Map<string, Baseline>()
// The current OpenChamber session id, to highlight its row in the session list.
let currentSessionId: string | null = null
// The active session's title from the host, used to name its row when the
// plugin has not recorded a title yet (a brand-new session shows only its id).
let currentSessionTitle: string | null = null
// Titles seen per session id via the host, kept so a row keeps a readable name
// even after it stops being the active session.
const sessionTitles = new Map<string, string>()
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
async function refreshLatestVersion(now: number): Promise<void> {
  if (latestVersion && now - latestVersionCheckedAt < VERSION_CHECK_MS) return
  latestVersionCheckedAt = now
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
}

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const fmt = (n: number, digits = 2): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US')

/** "13d 4h", "4h 20m", or "12m" from a millisecond span; empty when past. */
const fmtSpan = (ms: number, withSeconds = false): string => {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${m}m`
  // Below a minute, seconds keep the live "updated N ago" counter moving; the
  // reset ETA (withSeconds off) stays at minute resolution.
  if (m < 1 && withSeconds) return `${Math.floor(ms / 1000)}s`
  return `${m}m`
}

const fmtDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

const tone = (pct: number): 'success' | 'warning' | 'error' =>
  pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'success'

/**
 * Render one account card: plan, the credit bar, remaining, reset countdown,
 * overage terms, and the live burn since the panel opened.
 */
function renderAccount(container: HTMLElement, acc: AccountUsage, now: number): void {
  const card = container.appendChild(el('div', 'card'))

  const head = card.appendChild(el('div', 'row head'))
  const who = head.appendChild(el('div', 'who'))
  who.appendChild(el('div', 'email', acc.email))
  who.appendChild(el('div', 'muted small', `${acc.region}${acc.unit ? ` · ${acc.unit}s` : ''}`))
  if (acc.plan) {
    const badgeHost = head.appendChild(el('div'))
    mounted.push(mountBadge(badgeHost, { label: acc.plan, tone: acc.isHealthy ? 'primary' : 'warning' }))
  }
  if (!acc.isHealthy) {
    const badgeHost = head.appendChild(el('div'))
    mounted.push(mountBadge(badgeHost, { label: 'unhealthy', tone: 'error' }))
  }

  const remaining = Math.max(0, acc.limit - acc.used)
  const barHost = card.appendChild(el('div', 'bar'))
  mounted.push(
    mountProgress(barHost, {
      value: acc.pct,
      tone: tone(acc.pct),
      label: `${acc.pct}% · ${fmt(acc.used)} / ${fmtInt(acc.limit)}`
    })
  )

  const stats = card.appendChild(el('div', 'stats'))
  stats.appendChild(stat('Remaining', `${fmt(remaining)} credits`))

  if (acc.resetAt) {
    const untilMs = acc.resetAt - now
    const days = acc.daysUntilReset != null ? ` (${acc.daysUntilReset}d)` : ''
    stats.appendChild(stat('Resets', `${fmtDate(acc.resetAt)}${days}`))
    stats.appendChild(stat('Until reset', fmtSpan(untilMs)))
  }

  if (acc.overageStatus) {
    const rate = acc.overageRate != null ? `$${fmt(acc.overageRate, 2)}/credit` : ''
    const cap = acc.overageCap != null ? `, cap ${fmtInt(acc.overageCap)}` : ''
    const state = acc.overageStatus === 'DISABLED' ? ' (disabled)' : ''
    stats.appendChild(stat('Overage', `${rate}${state}${cap}`.trim() || acc.overageStatus))
    if (acc.currentOverages) stats.appendChild(stat('Overages spent', fmt(acc.currentOverages)))
  }

  // Live burn: credits used since the panel first saw this account, plus the
  // implied rate and a naive ETA to the limit at that rate.
  const base = baselines.get(acc.id)
  if (base && acc.used >= base.used && acc.updatedAt > base.at) {
    const spent = acc.used - base.used
    const hours = (acc.updatedAt - base.at) / 3_600_000
    if (spent > 0 && hours > 0.001) {
      const perHour = spent / hours
      stats.appendChild(stat('Used (this window)', `+${fmt(spent)} credits`))
      stats.appendChild(stat('Rate', `${fmt(perHour, 1)} credits/h`))
      if (perHour > 0 && remaining > 0) {
        const etaMs = (remaining / perHour) * 3_600_000
        stats.appendChild(stat('At this rate, empty in', fmtSpan(etaMs)))
      }
    }
  }
}

const stat = (label: string, value: string): HTMLElement => {
  const row = el('div', 'stat')
  row.appendChild(el('span', 'stat-label', label))
  row.appendChild(el('span', 'stat-value', value))
  return row
}

/**
 * Render the recent-session list with request counts and estimated credits.
 *
 * The estimate is apportioned from account deltas by request share, so it is
 * explicitly a best guess — the caption says so and the current session is
 * highlighted.
 */
function renderSessions(
  container: HTMLElement,
  sessions: SessionUsage[],
  emailById: Map<string, string>
): void {
  if (!sessions.length) return
  const sepHost = container.appendChild(el('div'))
  mounted.push(mountSeparator(sepHost, { label: 'Recent sessions (estimated)' }))

  const shown = sessions.slice(0, 12)
  // Scale each session's bar against the busiest session, so the list reads as
  // a quick "where did the credits go" at a glance.
  const maxCredits = Math.max(...shown.map((s) => s.estCredits), 0.0001)

  const listHost = container.appendChild(el('div', 'sessions'))
  for (const s of shown) renderSessionRow(listHost, s, maxCredits, emailById)

  container.appendChild(
    el(
      'div',
      'muted caption',
      'Credits per session are estimated: Kiro bills per request, not per token, and the account total is split across sessions by request share. A shared account mixes in other users.'
    )
  )
}

/**
 * The best readable name for a session row, in priority order:
 * the plugin's recorded title, the host title (for the active/known session),
 * the directory basename, then a short session id — never the full raw id.
 */
function sessionName(s: SessionUsage, isCurrent: boolean): string {
  const hostTitle = isCurrent ? currentSessionTitle : sessionTitles.get(s.sessionId)
  const title = s.title || (hostTitle && hostTitle !== s.sessionId ? hostTitle : undefined)
  if (title) return title
  const dir = s.directory?.split('/').pop()
  if (dir) return dir
  // Fall back to a short, tidy id rather than the full session-… string.
  return s.sessionId.replace(/^session-/, '').slice(0, 8)
}

/** One session row: name, path, a credit-share bar, and the credit/req figures. */
function renderSessionRow(
  container: HTMLElement,
  s: SessionUsage,
  maxCredits: number,
  emailById: Map<string, string>
): void {
  const isCurrent = currentSessionId != null && s.sessionId === currentSessionId
  const name = sessionName(s, isCurrent)

  const row = container.appendChild(el('button', `srow${isCurrent ? ' current' : ''}`))
  row.setAttribute('type', 'button')
  row.addEventListener('click', () => void host.openSession(s.sessionId).catch(() => {})) // open the chat

  const top = row.appendChild(el('div', 'srow-top'))
  const left = top.appendChild(el('div', 'srow-name'))
  left.appendChild(el('span', 'srow-title', name))
  if (isCurrent) {
    const b = left.appendChild(el('span', 'inline-badge'))
    mounted.push(mountBadge(b, { label: 'now', tone: 'primary' }))
  }
  const figures = top.appendChild(el('div', 'srow-figures'))
  figures.appendChild(el('span', 'srow-credits', `~${fmt(s.estCredits, 1)}`))
  figures.appendChild(el('span', 'srow-unit', 'cr'))
  figures.appendChild(el('span', 'srow-req', `${s.requests} req`))

  // Bar showing this session's share of the busiest one.
  const barWrap = row.appendChild(el('div', 'srow-bar'))
  const fill = barWrap.appendChild(el('div', 'srow-bar-fill'))
  fill.style.width = `${Math.max(2, Math.round((s.estCredits / maxCredits) * 100))}%`

  // The directory only when it adds something beyond the title.
  if (s.directory && s.directory.split('/').pop() !== name) {
    row.appendChild(el('div', 'srow-path muted', s.directory))
  }

  // Per-account split, only when more than one account served the session.
  if (s.accounts && s.accounts.length > 1) {
    const split = s.accounts
      .map((a) => {
        const who = emailById.get(a.accountId) ?? a.accountId.slice(0, 8)
        return `${who}: ~${fmt(a.estCredits, 1)} cr · ${a.requests} req`
      })
      .join('   ·   ')
    row.appendChild(el('div', 'srow-split muted', split))
  }
}

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

  const behind =
    latestVersion != null && compareSemver(latestVersion, MIN_SUPPORTED_VERSION) >= 0

  const body = behind
    ? `Usage tracking needs ${PLUGIN_PKG} v${MIN_SUPPORTED_VERSION} or newer. The latest is v${latestVersion}. Update the plugin, then it appears within seconds of starting OpenCode.`
    : `Usage tracking needs ${PLUGIN_PKG} v${MIN_SUPPORTED_VERSION} or newer. If OpenCode just started, this fills in within a few seconds.`

  const banner = mountBanner(root, {
    tone: 'warning',
    title: 'Waiting for the Kiro plugin',
    body,
    action: {
      label: 'Copy update command',
      onClick: () => void host.writeClipboard(`npm install -g ${PLUGIN_PKG}@latest`).catch(() => {})
    }
  })
  mounted.push(banner)
}

let lastFileKey = ''
// The candidate path that last held the snapshot, tried first next time so a
// steady state does not re-probe both locations on every poll.
let resolvedUsageFile: string | null = null

/**
 * Read the snapshot from the first candidate path that exists.
 *
 * Returns the parsed file, or throws the last error so the caller renders the
 * missing/error state. A NOT_FOUND on one candidate is not fatal — the next is
 * tried — but any other error (e.g. a permission or parse failure) surfaces.
 */
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

async function paint(force = false): Promise<void> {
  let file: UsageFile
  try {
    file = await readUsageFile()
  } catch (error) {
    clear()
    if (error instanceof HostRequestError && error.code === 'NOT_FOUND') {
      lastFileKey = ''
      await renderMissingFile(Date.now())
    } else {
      const msg = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error)
      mounted.push(mountBanner(root, { tone: 'error', title: 'Could not read usage', body: msg }))
    }
    return
  }

  // Skip a repaint when nothing changed, unless forced (theme/manual refresh).
  const key = JSON.stringify(file)
  if (!force && key === lastFileKey) return
  lastFileKey = key

  const now = Date.now()
  for (const acc of file.accounts ?? []) {
    if (!baselines.has(acc.id)) baselines.set(acc.id, { used: acc.used, at: acc.updatedAt || now })
  }

  // Fetch the latest npm version in the background; repaint once it lands so
  // the warning appears without blocking the first render.
  const hadLatest = latestVersion
  await refreshLatestVersion(now)
  if (latestVersion !== hadLatest && !force) {
    lastFileKey = ''
  }

  clear()

  if (!file.accounts?.length) {
    mounted.push(
      mountEmpty(root, { title: 'No Kiro accounts', body: 'Sign in to Kiro in OpenCode first.' })
    )
    return
  }

  const wrap = root.appendChild(el('div', 'wrap'))
  for (const acc of file.accounts) renderAccount(wrap, acc, now)
  const emailById = new Map(file.accounts.map((a) => [a.id, a.email]))
  renderSessions(wrap, file.sessions ?? [], emailById)

  renderVersion(wrap, file.pluginVersion, file.pluginInstances ?? [])

  const footer = wrap.appendChild(el('div', 'footer'))
  const updated = footer.appendChild(el('div', 'updated'))
  const label = updated.appendChild(el('span', 'muted tiny'))
  const staleBadgeHost = updated.appendChild(el('span', 'inline-badge'))

  // Tick the "updated Ns ago" label every second so it feels live between the
  // 10s polls, and flip to a "cached" badge once the reading goes stale.
  const writtenAt = file.writtenAt || now
  let staleShown = false
  const tick = () => {
    const age = Date.now() - writtenAt
    label.textContent = `Updated ${fmtSpan(age, true)} ago`
    const stale = age > STALE_MS
    if (stale && !staleShown) {
      staleShown = true
      mounted.push(mountBadge(staleBadgeHost, { label: 'cached', tone: 'warning' }))
    }
  }
  tick()
  const ticker = setInterval(tick, 1_000)
  mounted.push({ dispose: () => clearInterval(ticker) })

  const btnHost = footer.appendChild(el('div'))
  mounted.push(
    mountButton(btnHost, {
      label: 'Refresh',
      variant: 'ghost',
      size: 'xs',
      onClick: () => void paint(true)
    })
  )
}

/**
 * Show the installed plugin version and, when npm reports a newer one, a
 * warning banner with a one-click copy of the update command.
 */
function renderVersion(
  container: HTMLElement,
  installed: string | undefined,
  instances: PluginInstance[]
): void {
  const sepHost = container.appendChild(el('div'))
  mounted.push(mountSeparator(sepHost, { label: 'Plugin' }))

  if (!installed) {
    container.appendChild(el('div', 'muted tiny', `${PLUGIN_PKG}: version unknown`))
    return
  }

  // A version-split pool: more than one distinct live version. Warn and list
  // which install is on which version so the odd one out can be located.
  const versions = new Set(instances.map((i) => i.version))
  if (versions.size > 1) {
    const host2 = container.appendChild(el('div'))
    mounted.push(
      mountBanner(host2, {
        tone: 'warning',
        title: 'Plugin versions out of sync',
        body: `${versions.size} versions are running at once. Update every OpenCode install to the same version.`
      })
    )
    renderInstanceList(container, instances)
    return
  }

  const outdated = latestVersion != null && compareSemver(installed, latestVersion) < 0

  if (outdated) {
    const host2 = container.appendChild(el('div'))
    mounted.push(
      mountBanner(host2, {
        tone: 'warning',
        title: `Update available — v${latestVersion}`,
        body: `Installed v${installed}. Update ${PLUGIN_PKG} to get the latest fixes.`,
        action: {
          label: 'Copy update command',
          onClick: () =>
            void host.writeClipboard(`npm install -g ${PLUGIN_PKG}@latest`).catch(() => {})
        }
      })
    )
  } else {
    const row = container.appendChild(el('div', 'stat'))
    row.appendChild(el('span', 'stat-label', PLUGIN_PKG))
    const val = el('span', 'stat-value')
    val.appendChild(el('span', undefined, `v${installed}`))
    const badgeHost = val.appendChild(el('span', 'inline-badge'))
    mounted.push(
      mountBadge(badgeHost, {
        label: latestVersion ? 'up to date' : 'installed',
        tone: latestVersion ? 'success' : 'neutral'
      })
    )
    row.appendChild(val)
  }

  // Even when versions agree, show the pool if more than one instance runs, so
  // the concurrency (the "10 sessions" case) is visible.
  if (instances.length > 1) renderInstanceList(container, instances)
}

/** List each live instance: version, a short install path, and pid. */
function renderInstanceList(container: HTMLElement, instances: PluginInstance[]): void {
  const items = instances.map((i) => ({
    id: String(i.pid),
    title: `v${i.version}${i.self ? '  ·  this session' : ''}`,
    subtitle: shortenPath(i.source),
    meta: `pid ${i.pid}`,
    badge: i.self ? { label: 'here', tone: 'primary' as const } : undefined
  }))
  const listHost = container.appendChild(el('div'))
  mounted.push(
    mountList(listHost, { items, ariaLabel: 'Running plugin instances', onSelect: () => {} })
  )
}

/** Trim an install path to its tail so the meaningful part fits the panel. */
function shortenPath(source: string | undefined): string | undefined {
  if (!source) return undefined
  const parts = source.split('/')
  return parts.length <= 4 ? source : `…/${parts.slice(-4).join('/')}`
}

function injectStyles(): void {
  const style = document.createElement('style')
  // Sizes are in em so everything scales with the host font-size (OpenChamber
  // sets 0.875rem + line-height 1.45 on the root via applyHostReady); colours
  // use the host's own tokens (--oc-fg/--oc-muted/--oc-border/--oc-hover/
  // --oc-primary) so the panel matches the app's theme, light or dark.
  style.textContent = `
    .wrap { display: flex; flex-direction: column; gap: 1.15em; }
    .card { display: flex; flex-direction: column; gap: 0.85em; padding: 1em; border-radius: var(--oc-radius, 0.5em); background: var(--oc-elevated, rgba(127,127,127,0.06)); border: 1px solid var(--oc-border, transparent); }
    .row { display: flex; align-items: center; }
    .head { justify-content: space-between; gap: 0.6em; }
    .who { display: flex; flex-direction: column; gap: 0.2em; min-width: 0; }
    .email { font-weight: 600; font-size: 1.05em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head > div { display: flex; gap: 0.4em; align-items: center; }
    .bar { margin: 0.15em 0; }
    .stats { display: grid; grid-template-columns: 1fr; gap: 0.4em; }
    .stat { display: flex; justify-content: space-between; gap: 0.85em; }
    .stat-label { color: var(--oc-muted, #888); }
    .stat-value { font-variant-numeric: tabular-nums; text-align: right; display: flex; align-items: center; gap: 0.4em; justify-content: flex-end; }
    .muted { color: var(--oc-muted, #888); }
    .small { font-size: 0.9em; }
    .tiny { font-size: 0.85em; line-height: 1.4; }
    .caption { font-size: 0.9em; line-height: 1.55; margin-top: 0.4em; }
    .footer { display: flex; align-items: center; justify-content: space-between; margin-top: 0.15em; }
    .updated { display: flex; align-items: center; gap: 0.4em; }
    .inline-badge { display: inline-flex; }
    .sessions { display: flex; flex-direction: column; gap: 0.25em; }
    .srow { display: flex; flex-direction: column; gap: 0.4em; width: 100%; text-align: left; padding: 0.65em 0.75em; border: 0; border-radius: var(--oc-radius, 0.5em); background: transparent; color: inherit; font: inherit; cursor: pointer; transition: background 0.12s ease; }
    .srow:hover { background: var(--oc-hover, rgba(127,127,127,0.10)); }
    .srow.current { background: color-mix(in srgb, var(--oc-primary, #6b8afd) 12%, transparent); }
    .srow-top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.7em; }
    .srow-name { display: flex; align-items: center; gap: 0.4em; min-width: 0; }
    .srow-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .srow-figures { display: flex; align-items: baseline; gap: 0.3em; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .srow-credits { font-weight: 600; }
    .srow-unit { font-size: 0.85em; color: var(--oc-muted, #888); }
    .srow-req { font-size: 0.85em; color: var(--oc-muted, #888); margin-left: 0.3em; }
    .srow-bar { height: 0.3em; border-radius: 0.15em; background: var(--oc-muted-surface, rgba(127,127,127,0.14)); overflow: hidden; }
    .srow-bar-fill { height: 100%; border-radius: 0.15em; background: var(--oc-primary, #6b8afd); }
    .srow-path { font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .srow-split { font-size: 0.85em; }
  `
  document.head.appendChild(style)
}

// Subscribe to the sessions of the current project so the list can highlight
// the active chat. Errors (e.g. no sessions permission granted) are non-fatal.
async function trackCurrentProject(): Promise<void> {
  try {
    const projects = await host.listProjects()
    const projectId = projects.projects[0]?.id
    if (!projectId) return
    await host.onSessions(projectId, () => {
      // A repaint keeps the "current" highlight fresh; readFile is cheap.
      void paint(true)
    })
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
  void paint(true)
  void trackCurrentProject()
  setInterval(() => void paint(), POLL_MS)
})

host.onSession((session) => {
  const next = session?.id ?? null
  // Remember the title, even a fallback-to-id one, so a freshly started session
  // gets a readable row before the plugin records its own title.
  if (session?.id && session.title && session.title !== session.id) {
    sessionTitles.set(session.id, session.title)
  }
  const nextTitle = session?.title ?? null
  if (next === currentSessionId && nextTitle === currentSessionTitle) return
  currentSessionId = next
  currentSessionTitle = nextTitle
  void paint(true)
})
