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

const USAGE_FILE = '~/.config/opencode/kiro-usage.json'
const POLL_MS = 15_000

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
const fmtSpan = (ms: number): string => {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${m}m`
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

  const listHost = container.appendChild(el('div'))
  const items = sessions.slice(0, 12).map((s) => {
    const isCurrent = currentSessionId != null && s.sessionId === currentSessionId
    const title = s.title || s.directory?.split('/').pop() || s.sessionId.slice(0, 12)
    // Only surface the split when more than one account actually served the
    // session; a single-account session's totals already say everything.
    const split =
      s.accounts && s.accounts.length > 1
        ? s.accounts
            .map((a) => {
              const who = emailById.get(a.accountId) ?? a.accountId.slice(0, 8)
              return `${who}: ~${fmt(a.estCredits, 1)} cr · ${a.requests} req`
            })
            .join('   ')
        : undefined
    return {
      id: s.sessionId,
      title: isCurrent ? `${title}  ·  current` : title,
      subtitle: split ? `${s.directory ? `${s.directory}  ·  ` : ''}${split}` : s.directory,
      meta: `~${fmt(s.estCredits, 1)} cr · ${s.requests} req`,
      badge: isCurrent ? { label: 'now', tone: 'primary' as const } : undefined
    }
  })
  mounted.push(
    mountList(listHost, {
      items,
      ariaLabel: 'Recent Kiro sessions',
      onSelect: (id) => void host.openSession(id).catch(() => {})
    })
  )

  container.appendChild(
    el(
      'div',
      'muted tiny',
      'Credits per session are estimated: Kiro bills per request, not per token, and the account total is split across sessions by request share. A shared account mixes in other users.'
    )
  )
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

async function paint(force = false): Promise<void> {
  let file: UsageFile
  try {
    const { content } = await host.readFile(USAGE_FILE)
    file = JSON.parse(content) as UsageFile
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
  footer.appendChild(
    el('span', 'muted tiny', `Updated ${fmtSpan(now - (file.writtenAt || now))} ago`)
  )
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
  style.textContent = `
    .wrap { display: flex; flex-direction: column; gap: 14px; }
    .card { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: var(--oc-radius, 8px); background: var(--oc-surface-1, rgba(127,127,127,0.06)); }
    .row { display: flex; align-items: center; }
    .head { justify-content: space-between; gap: 8px; }
    .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .email { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .head > div { display: flex; gap: 6px; align-items: center; }
    .bar { margin: 2px 0; }
    .stats { display: grid; grid-template-columns: 1fr; gap: 4px; }
    .stat { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
    .stat-label { color: var(--oc-text-muted, #888); }
    .stat-value { font-variant-numeric: tabular-nums; text-align: right; display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
    .muted { color: var(--oc-text-muted, #888); }
    .small { font-size: 11px; }
    .tiny { font-size: 10px; line-height: 1.4; }
    .footer { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
    .inline-badge { display: inline-flex; }
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
  if (next === currentSessionId) return
  currentSessionId = next
  void paint(true)
})
