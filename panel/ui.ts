// Small DOM, formatting and chart helpers. No data logic lives here.
//
// Colours: only OpenChamber's own tokens (`--oc-*`, written onto the document by
// applyHostReady). No hex fallbacks — a missing token falls back to inherited
// colour, never to a hardcoded theme.

export const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

export const NS = 'http://www.w3.org/2000/svg'
export const svgEl = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** A stroked line-icon (Feather-style), sized in em so it scales with text. */
export function icon(paths: string, size = 0.85): SVGElement {
  const svg = svgEl('svg', {
    width: `${size}em`,
    height: `${size}em`,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2.4,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: 'ico',
    'aria-hidden': 'true'
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
export const ICON_BOLT = 'M13 2 3 14h7l-1 8 10-12h-7z'
export const ICON_CLOCK = 'circle:12,12,9|M12 7v5l3 2'
export const ICON_CHEVRON_DOWN = 'M6 9l6 6 6-6'
export const ICON_INFO = 'circle:12,12,10|M12 16v-4|M12 8h.01'
export const ICON_ARROW_LEFT = 'M19 12H5|M12 19l-7-7 7-7'
export const ICON_EXTERNAL = 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6|M15 3h6v6|M10 14 21 3'
export const ICON_ALERT = 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4|M12 17h.01'
export const ICON_TOOL =
  'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z'

/**
 * An ⓘ that reveals its explanation in a CSS tooltip.
 *
 * Native title= is unreliable in the sandboxed iframe, so this shows the text
 * from an own element on hover/focus. It is anchored to the panel root (a
 * full-width bubble) so it never forces a horizontal scroll.
 */
export function infoIcon(text: string): HTMLElement {
  const wrap = el('span', 'info-wrap')
  wrap.setAttribute('tabindex', '0')
  wrap.setAttribute('role', 'img')
  wrap.setAttribute('aria-label', text)
  const ico = icon(ICON_INFO, 0.85)
  ico.classList.add('info-ico')
  wrap.appendChild(ico)
  const tip = el('span', 'tip', text)
  wrap.appendChild(tip)
  const place = () => {
    const root = document.querySelector('#root') as HTMLElement
    const rootBox = root.getBoundingClientRect()
    const iconBox = wrap.getBoundingClientRect()
    tip.style.top = `${iconBox.bottom - rootBox.top + root.scrollTop + 6}px`
  }
  wrap.addEventListener('mouseenter', place)
  wrap.addEventListener('focus', place)
  return wrap
}

// ── formatting ────────────────────────────────────────────────────────────────

export const NOT_REPORTED = 'not reported'

export const fmt = (n: number, digits = 2): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US')

/** Estimated credits, always prefixed with "~" so it can never read as exact. */
export const estCr = (n: number, digits = 1): string => `~${fmt(n, digits)}`

/** A muted "not reported" span, used wherever a value is missing. */
export const notReported = (): HTMLElement => el('span', 'nr', NOT_REPORTED)

/** "13d 4h", "4h 20m", or "12m"/"9s" from a millisecond span. */
export const fmtSpan = (ms: number, withSeconds = false): string => {
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

/** "just now", "5m ago", "3h ago", "2d ago". */
export const fmtAgo = (ms: number, now: number): string => {
  const d = now - ms
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

export const fmtShortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short' })

export const fmtApproxDate = (ms: number): string => `≈ ${fmtShortDate(ms)}`

export const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })

export const fmtDuration = (ms: number): string => {
  if (ms < 60_000) return '<1m'
  return fmtSpan(ms)
}

export const fmtCompact = (n: number): string =>
  n >= 10_000_000_000 ? `${(n / 1_000_000_000).toFixed(0)}B`
  : n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B`
  : n >= 10_000_000 ? `${(n / 1_000_000).toFixed(0)}M`
    : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 10_000 ? `${(n / 1000).toFixed(0)}k`
        : n >= 1000 ? `${(n / 1000).toFixed(1)}k`
          : fmtInt(n)

// ── tones ─────────────────────────────────────────────────────────────────────

/**
 * Which tone an account's usage warrants.
 *
 * Percentage alone misreads a large pool — 90% of 10k credits is still 1k
 * left — so error also triggers on a small absolute remainder.
 */
export type Tone = 'success' | 'warning' | 'error'
export const REMAINING_CRITICAL = 200
export function toneFor(pct: number, remaining: number): Tone {
  if (pct >= 95 || remaining < REMAINING_CRITICAL) return 'error'
  if (pct >= 85) return 'warning'
  return 'success'
}
export const toneVar = (t: Tone): string => `var(--oc-${t})`
export const toneText = (t: Tone): string => `var(--oc-${t}-text)`

/** Context fill tone: a nearly full context window is what hurts. */
export const contextTone = (pct: number): Tone =>
  pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'success'

// ── small visual primitives ───────────────────────────────────────────────────

/** Circular usage ring. `text` adds the big % + "used" label (large size only). */
export function ring(pct: number, t: Tone, size = 88, stroke = 6.5, text = true): SVGElement {
  const r = 36
  const circ = 2 * Math.PI * r
  const svg = svgEl('svg', {
    width: size,
    height: size,
    viewBox: '0 0 88 88',
    class: 'donut',
    role: 'img',
    'aria-label': `${pct}% used`
  })
  svg.appendChild(
    svgEl('circle', { cx: 44, cy: 44, r, fill: 'none', stroke: 'var(--oc-border)', 'stroke-width': stroke })
  )
  const clamped = Math.min(100, Math.max(0, pct))
  svg.appendChild(
    svgEl('circle', {
      cx: 44, cy: 44, r, fill: 'none', stroke: toneVar(t), 'stroke-width': stroke,
      'stroke-linecap': 'round', 'stroke-dasharray': circ.toFixed(2),
      'stroke-dashoffset': (circ * (1 - clamped / 100)).toFixed(2),
      transform: 'rotate(-90 44 44)'
    })
  )
  if (text) {
    const main = svgEl('text', {
      x: 44, y: 47, 'text-anchor': 'middle', 'font-size': 19, 'font-weight': 700, fill: 'var(--oc-fg)'
    })
    main.textContent = `${pct}%`
    svg.appendChild(main)
    const sub = svgEl('text', {
      x: 44, y: 60, 'text-anchor': 'middle', 'font-size': 7.5, fill: 'var(--oc-muted)'
    })
    sub.textContent = 'used'
    svg.appendChild(sub)
  }
  return svg
}

/** A thin horizontal bar; `frac` 0..1, `color` a CSS colour (token) string. */
export function hbar(frac: number, color = 'var(--oc-primary)'): HTMLElement {
  const track = el('div', 'hbar')
  const fill = track.appendChild(el('div', 'hbar-fill'))
  fill.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`
  fill.style.background = color
  return track
}

/**
 * A thin bar split into coloured segments (e.g. one per account). The whole bar is
 * `frac` of the track wide, so rows stay comparable; segments share it by value.
 */
export function segBar(parts: Array<{ value: number; color: string }>, frac: number): HTMLElement {
  const track = el('div', 'hbar')
  const inner = track.appendChild(el('div', 'segbar'))
  inner.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`
  for (const p of parts) {
    if (!(p.value > 0)) continue
    const seg = inner.appendChild(el('i'))
    seg.style.flexGrow = String(p.value)
    seg.style.background = p.color
  }
  return track
}

/** Tiny non-interactive bar sparkline. `null` renders as a hatched "no data" stub. */
export function spark(values: Array<number | null>, color = 'var(--oc-primary)'): HTMLElement {
  const wrap = el('span', 'spark')
  wrap.setAttribute('aria-hidden', 'true')
  const max = Math.max(1e-9, ...values.map((v) => v ?? 0))
  for (const v of values) {
    const col = wrap.appendChild(el('i'))
    if (v == null) col.className = 'spark-nr'
    else {
      col.style.height = `${Math.max(v > 0 ? 12 : 4, (v / max) * 100)}%`
      col.style.background = v > 0 ? color : 'var(--oc-border)'
    }
  }
  return wrap
}

export interface BarDatum {
  value: number | null
  today: boolean
  aria: string
}

/**
 * Interactive bar chart (HTML flex bars: responsive, themeable, focusable).
 * `null` values are drawn hatched ("not reported"), 0 as a flat tick. Selecting a
 * bar (hover, focus, tap) calls `onSelect` so the caller can update a readout —
 * native tooltips are suppressed in the sandbox.
 */
export function barChart(
  data: BarDatum[],
  avg: number | null,
  onSelect: (i: number) => void
): { node: HTMLElement; select: (i: number) => void } {
  const wrap = el('div', 'bars')
  wrap.setAttribute('role', 'group')
  const max = Math.max(1e-9, ...data.map((d) => d.value ?? 0), avg ?? 0)
  const cols: HTMLElement[] = []
  const select = (i: number) => {
    cols.forEach((c, j) => c.classList.toggle('bar-sel', i === j))
    onSelect(i)
  }
  data.forEach((d, i) => {
    const col = wrap.appendChild(el('button', 'bar'))
    col.setAttribute('type', 'button')
    col.setAttribute('aria-label', d.aria)
    const fill = col.appendChild(el('i'))
    if (d.value == null) col.classList.add('bar-nr')
    else {
      fill.style.height = `${Math.max(d.value > 0 ? 4 : 0, (d.value / max) * 100)}%`
      if (d.value === 0) col.classList.add('bar-zero')
    }
    if (d.today) col.classList.add('bar-today')
    col.addEventListener('mouseenter', () => select(i))
    col.addEventListener('focus', () => select(i))
    col.addEventListener('click', () => select(i))
    cols.push(col)
  })
  if (avg != null && avg > 0) {
    const line = wrap.appendChild(el('span', 'bars-avg'))
    line.style.bottom = `${(avg / max) * 100}%`
  }
  return { node: wrap, select }
}
