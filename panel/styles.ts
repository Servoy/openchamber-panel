// All panel CSS. Colours are OpenChamber `--oc-*` tokens only (written onto the
// document by applyHostReady); there are no hardcoded colour fallbacks.
// Sizes track the host font (applyHostReady sets ~0.875rem on the root), so
// everything is in em.
export const STYLES = `
  /* The panel itself scrolls (the rail is narrow and the content is tall). It is
     width-locked so no child can widen it, and a container, so the layout reacts
     to the space it is given (rail vs full-screen page), not to the window. */
  #root { color: var(--oc-fg); max-width: 100%; height: 100%; overflow-x: hidden; overflow-y: auto; box-sizing: border-box; position: relative; container-type: inline-size; scrollbar-gutter: stable; }
  .mono { font-family: var(--oc-mono); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .muted, .subtle { color: var(--oc-muted); }
  .xs { font-size: 0.8em; }
  .grow { flex: 1; }
  .ico { flex-shrink: 0; }
  .nr { color: var(--oc-muted); font-style: italic; font-weight: 400; font-size: 0.85em; font-family: var(--oc-font); letter-spacing: 0; }
  button { font: inherit; color: inherit; }
  button:focus-visible, .info-wrap:focus-visible { outline: 2px solid var(--oc-focus); outline-offset: 1px; }

  .wrap { display: flex; flex-direction: column; gap: 1em; max-width: 100%; min-width: 0; box-sizing: border-box; min-height: 100%; }
  .layout { display: flex; flex-direction: column; gap: 1em; min-width: 0; }
  .col { display: flex; flex-direction: column; gap: 1em; min-width: 0; }
  .detail { max-width: 46em; }
  @container (min-width: 760px) {
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; gap: 1.2em; }
    .detail { margin: 0 auto; width: 100%; }
  }
  @container (min-width: 1200px) {
    .wrap { max-width: 1180px; margin: 0 auto; width: 100%; }
  }

  .sec { display: flex; flex-direction: column; gap: 0.7em; padding: 1em; border-radius: 0.72em; background: var(--oc-elevated); border: 1px solid var(--oc-border); min-width: 0; }
  .sec-head { display: flex; align-items: center; gap: 0.45em; min-height: 1.6em; }
  .sec-title { font-size: 0.92em; font-weight: 600; }
  .subhead { display: flex; align-items: center; gap: 0.45em; font-size: 0.8em; font-weight: 600; color: var(--oc-muted); margin-top: 0.4em; padding-top: 0.7em; border-top: 1px solid var(--oc-border); }

  /* Estimate / exact tags: every non-hard number carries one of these or a "~". */
  .tag-est { font-size: 0.66em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 0.1em 0.5em; border-radius: 999px; color: var(--oc-warning-text); background: color-mix(in srgb, var(--oc-warning) 14%, transparent); white-space: nowrap; flex-shrink: 0; }
  .tag-exact { font-size: 0.66em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; padding: 0.1em 0.5em; border-radius: 999px; color: var(--oc-success-text); background: color-mix(in srgb, var(--oc-success) 14%, transparent); white-space: nowrap; flex-shrink: 0; }

  .hero { gap: 0.8em; }
  .acc-head { display: flex; align-items: center; gap: 0.6em; }
  .avatar { width: 1.35em; height: 1.35em; border-radius: 999px; background: var(--oc-hover); display: flex; align-items: center; justify-content: center; font-size: 0.7em; font-weight: 700; color: var(--oc-muted); flex-shrink: 0; }
  .acc-email { font-size: 0.95em; font-weight: 500; color: var(--oc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .pill { font-size: 0.72em; color: var(--oc-muted); background: var(--oc-hover); border-radius: 999px; padding: 0.15em 0.6em; flex-shrink: 0; white-space: nowrap; }
  .pill-error { color: var(--oc-error-text); background: color-mix(in srgb, var(--oc-error) 14%, transparent); }

  .acc-body { display: flex; align-items: center; gap: 1.15em; }
  .donut { flex-shrink: 0; }
  .ring-nr { width: 88px; height: 88px; display: flex; align-items: center; justify-content: center; border-radius: 999px; border: 6.5px solid var(--oc-border); box-sizing: border-box; text-align: center; flex-shrink: 0; }
  .acc-figures { display: flex; flex-direction: column; gap: 0.4em; min-width: 0; flex: 1; }
  .big { font-size: 1.3em; font-weight: 600; }
  .hr { height: 1px; background: var(--oc-border); }
  .fig-row { display: flex; align-items: flex-start; gap: 0.4em; color: var(--oc-muted); min-width: 0; }
  .fig-row > .ico { margin-top: 0.3em; }
  .fig-row > .mono, .fig-row > .xs { min-width: 0; flex: 0 1 auto; }
  .fig-row > .tag-est, .fig-row > .tag-exact { margin-top: 0.15em; }
  /* The rate reads "≈ 391 cr/workday" on one line, its basis ("month avg") below it. */
  .rate-val { white-space: nowrap; }
  .rate-basis { display: block; }
  .fig-row > .info-wrap { margin-top: 0.25em; }

  .period { display: flex; flex-direction: column; gap: 0.35em; }
  .period-line { display: flex; justify-content: space-between; gap: 0.6em; flex-wrap: wrap; }
  .pbar { position: relative; height: 0.5em; border-radius: 999px; background: var(--oc-border); }
  .pbar-fill { height: 100%; border-radius: 999px; transition: width 0.3s ease; }
  /* Marks how far through the period we are: fill past the mark = spending ahead of time. */
  .pbar-mark { position: absolute; top: -0.2em; bottom: -0.2em; width: 2px; margin-left: -1px; background: var(--oc-fg); border-radius: 1px; }

  .proj { display: flex; align-items: flex-start; gap: 0.6em; padding: 0.6em 0.75em; border-radius: 0.55em; background: var(--oc-hover); }
  .proj > .ico { margin-top: 0.15em; }
  .proj-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15em; }
  .proj-main { font-weight: 600; font-size: 0.9em; }
  .proj-sub { color: var(--oc-muted); }
  .proj-tags { display: flex; align-items: center; gap: 0.35em; flex-shrink: 0; }
  .proj-success { background: color-mix(in srgb, var(--oc-success) 12%, transparent); color: var(--oc-success-text); }
  .proj-warning { background: color-mix(in srgb, var(--oc-warning) 14%, transparent); color: var(--oc-warning-text); }
  .proj-error { background: color-mix(in srgb, var(--oc-error) 14%, transparent); color: var(--oc-error-text); }
  .proj-success .proj-sub, .proj-warning .proj-sub, .proj-error .proj-sub { color: var(--oc-fg); opacity: 0.8; }

  .details-toggle { align-self: center; display: flex; align-items: center; gap: 0.3em; font-size: 0.78em; color: var(--oc-muted); background: transparent; border: 0; padding: 0.2em 0.6em; border-radius: 0.45em; cursor: pointer; }
  .details-toggle:hover { background: var(--oc-hover); }
  .details-toggle .ico { transition: transform 0.15s ease; }
  .details { display: flex; flex-direction: column; gap: 0.45em; padding-top: 0.6em; border-top: 1px solid var(--oc-border); }
  .detail-row { display: flex; align-items: center; justify-content: space-between; gap: 0.8em; min-width: 0; }
  .acct-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  /* Account switcher */
  .chips { display: flex; gap: 0.4em; overflow-x: auto; padding-bottom: 0.1em; }
  .chip { display: inline-flex; align-items: center; gap: 0.45em; padding: 0.3em 0.75em; border-radius: 999px; border: 1px solid var(--oc-border); background: transparent; cursor: pointer; font-size: 0.82em; white-space: nowrap; flex-shrink: 0; }
  .chip:hover { background: var(--oc-hover); }
  .chip.on { background: var(--oc-active); border-color: var(--oc-primary); }
  .chip-name { max-width: 9em; overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 0.45em; height: 0.45em; border-radius: 999px; flex-shrink: 0; }

  /* Key figures */
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6em; }
  /* An odd last tile spans the row instead of leaving a hole. */
  .tiles > .tile:last-child:nth-child(odd) { grid-column: 1 / -1; }
  /* The account's three key figures sit side by side once there is room for them. */
  @container (min-width: 300px) {
    .tiles.tiles-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.45em; }
    .tiles.tiles-3 > .tile:last-child:nth-child(odd) { grid-column: auto; }
    .tiles.tiles-3 > .tile { padding: 0.6em 0.6em; }
  }
  .tile { padding: 0.65em 0.75em; border-radius: 0.6em; background: var(--oc-elevated); border: 1px solid var(--oc-border); min-width: 0; display: flex; flex-direction: column; gap: 0.2em; }
  .sec .tile { background: var(--oc-hover); border-color: transparent; }
  .tile-label { display: flex; align-items: center; gap: 0.4em; flex-wrap: wrap; font-size: 0.74em; color: var(--oc-muted); }
  .tile-value { font-size: 1.2em; font-weight: 600; }
  .tile-sub { overflow-wrap: anywhere; line-height: 1.35; }

  /* Charts */
  .bars { position: relative; display: flex; align-items: flex-end; gap: 3px; height: 6em; padding-top: 0.2em; }
  .bar { flex: 1; min-width: 0; height: 100%; display: flex; align-items: flex-end; padding: 0; border: 0; background: transparent; cursor: pointer; border-radius: 3px; position: relative; }
  .bar > i { display: block; width: 100%; min-height: 0; background: var(--oc-primary); border-radius: 3px 3px 1px 1px; opacity: 0.55; transition: opacity 0.12s ease, height 0.25s ease; }
  .bar-today > i { opacity: 1; }
  .bar:hover > i, .bar:focus-visible > i, .bar-sel > i { opacity: 1; }
  .bar-zero::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--oc-border); border-radius: 1px; }
  /* Hatched = not reported (before the plugin started recording), distinct from a zero day. */
  .bar-nr::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 28%; border-radius: 3px; background: repeating-linear-gradient(135deg, var(--oc-border) 0 2px, transparent 2px 5px); }
  .bars-avg { position: absolute; left: 0; right: 0; height: 0; border-top: 1px dashed var(--oc-muted); pointer-events: none; opacity: 0.7; }
  .axis { display: flex; justify-content: space-between; }
  .readout { min-height: 2.6em; line-height: 1.4; white-space: pre-wrap; }
  .spark { display: inline-flex; align-items: flex-end; gap: 1px; height: 1.2em; width: 5em; }
  .spark > i { flex: 1; border-radius: 1px; }
  .spark-nr { height: 25%; background: repeating-linear-gradient(135deg, var(--oc-border) 0 1px, transparent 1px 3px); }
  .hbar { height: 0.32em; border-radius: 999px; background: var(--oc-border); overflow: hidden; width: 100%; }
  .segbar { display: flex; gap: 1px; height: 100%; border-radius: 999px; overflow: hidden; transition: width 0.3s ease; }
  .segbar > i { display: block; height: 100%; min-width: 2px; flex-basis: 0; }
  .srow-accts { display: flex; flex-wrap: wrap; gap: 0.15em 0.9em; min-width: 0; }
  .srow-accts-col { display: flex; flex-direction: column; gap: 0.4em; }
  .acct-chip { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 0.4em; min-width: 0; max-width: 100%; }
  .acct-chip > * { flex-shrink: 0; }
  .acct-chip .dot { align-self: center; }
  .acct-chip-name { font-size: 0.78em; font-weight: 500; max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct-gone { font-style: italic; font-weight: 400; color: var(--oc-muted); }
  .hbar-fill { height: 100%; border-radius: 999px; transition: width 0.3s ease; }

  .seg { display: inline-flex; align-self: flex-start; padding: 2px; border-radius: 0.55em; background: var(--oc-hover); gap: 2px; flex-wrap: wrap; }
  .seg-btn { border: 0; background: transparent; color: var(--oc-muted); font-size: 0.78em; padding: 0.25em 0.7em; border-radius: 0.4em; cursor: pointer; }
  .seg-btn:hover { color: var(--oc-fg); }
  .seg-btn.on { background: var(--oc-elevated); color: var(--oc-fg); box-shadow: 0 0 0 1px var(--oc-border); }

  .empty-note { padding: 0.7em 0.8em; border-radius: 0.5em; background: var(--oc-hover); line-height: 1.5; }

  /* Tools */
  .tools { display: flex; flex-direction: column; gap: 0.55em; }
  .trow { display: flex; flex-direction: column; gap: 0.25em; min-width: 0; }
  .trow-top { display: flex; justify-content: space-between; align-items: baseline; gap: 0.6em; min-width: 0; }
  .trow-name { font-size: 0.86em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; overflow-wrap: normal; }
  .trow-nums { flex-shrink: 0; white-space: nowrap; }
  .hits { display: flex; flex-direction: column; }
  .hit { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: baseline; column-gap: 0.55em; text-align: left; padding: 0.4em 0.35em; border: 0; border-bottom: 1px solid var(--oc-border); background: transparent; cursor: pointer; border-radius: 0.3em; }
  .hit:last-child { border-bottom: 0; }
  .hit:hover { background: var(--oc-hover); }
  .hit-tool { font-size: 0.84em; font-weight: 500; }
  .hit-sess { color: var(--oc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .hit-cost { white-space: nowrap; text-align: right; }

  /* Tokens */
  .stack { display: flex; height: 0.65em; border-radius: 999px; overflow: hidden; background: var(--oc-border); gap: 1px; }
  .stack > i { display: block; height: 100%; min-width: 2px; }
  .legend { display: flex; flex-direction: column; gap: 0.3em; }
  .legend-row { display: grid; grid-template-columns: auto 1fr auto 3em; align-items: center; column-gap: 0.55em; }
  .legend-label { color: var(--oc-muted); }
  .legend-pct { text-align: right; }

  /* Accounts list */
  .acct-list { display: flex; flex-direction: column; gap: 0.3em; }
  .acct-row { display: flex; align-items: center; gap: 0.7em; padding: 0.45em 0.5em; border: 1px solid transparent; border-radius: 0.55em; background: transparent; cursor: pointer; text-align: left; min-width: 0; }
  .acct-row:hover { background: var(--oc-hover); }
  .acct-row.on { border-color: var(--oc-border); background: var(--oc-hover); }
  .acct-mid { flex: 1; min-width: 0; }
  .acct-name { font-size: 0.88em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acct-req { flex-shrink: 0; text-align: right; }

  /* Sessions */
  .sessions { display: flex; flex-direction: column; min-width: 0; }
  .srow { display: flex; flex-direction: column; gap: 0.3em; width: 100%; min-width: 0; box-sizing: border-box; text-align: left; padding: 0.6em 0.55em; border: 0; border-left: 2px solid transparent; border-bottom: 1px solid var(--oc-border); background: transparent; cursor: pointer; transition: background 0.12s ease; border-radius: 0; }
  .srow:last-child { border-bottom: 0; }
  .srow:hover { background: var(--oc-hover); }
  .srow.current { border-left-color: var(--oc-primary); }
  .srow-top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8em; min-width: 0; }
  .srow-name { display: flex; align-items: center; gap: 0.45em; min-width: 0; flex: 1; }
  .srow-title { font-size: 1em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .srow-title.muted { font-weight: 400; }
  .now { font-size: 0.72em; font-weight: 600; color: var(--oc-primary-text); flex-shrink: 0; }
  /* Credits of sessions begun before per-response metering: overcounted, so dimmed. */
  .srow-credits.pre { color: var(--oc-muted); text-decoration: underline dotted; text-underline-offset: 0.2em; }
  .pre-note { margin: 0.3em 0 0.5em; }
  .trow-name .info-wrap { margin-left: 0.35em; }
  .badge-warn { font-size: 0.66em; font-weight: 600; padding: 0.1em 0.5em; border-radius: 999px; color: var(--oc-warning-text); background: color-mix(in srgb, var(--oc-warning) 14%, transparent); flex-shrink: 0; white-space: nowrap; }
  .srow-figures { font-size: 0.92em; flex-shrink: 0; white-space: nowrap; }
  .srow-credits { font-weight: 500; }
  /* Project name shrinks first, so requests, age and failures stay readable. */
  .srow-meta { display: flex; white-space: nowrap; overflow-wrap: normal; min-width: 0; }
  .srow-meta > span { flex-shrink: 0; }
  .srow-meta > .srow-proj { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .srow-turns { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
  .srow-path, .srow-split { font-size: 0.78em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; width: 100%; min-width: 0; box-sizing: border-box; }

  /* Drill-down */
  .back { align-self: flex-start; display: inline-flex; align-items: center; gap: 0.45em; padding: 0.3em 0.7em 0.3em 0.5em; border: 0; border-radius: 0.5em; background: transparent; color: var(--oc-muted); cursor: pointer; font-size: 0.86em; }
  .back:hover { background: var(--oc-hover); color: var(--oc-fg); }
  .d-title { display: flex; align-items: baseline; gap: 0.5em; min-width: 0; }
  .d-name { font-size: 1.1em; font-weight: 600; overflow-wrap: anywhere; }
  .d-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; overflow-wrap: normal; }
  .ctx-row { display: flex; align-items: baseline; gap: 0.7em; }
  .actions { display: flex; gap: 0.5em; flex-wrap: wrap; }
  .btn { padding: 0.45em 0.9em; border-radius: 0.5em; border: 1px solid var(--oc-border); background: transparent; cursor: pointer; font-size: 0.86em; }
  .btn:hover { background: var(--oc-hover); }
  .btn.primary { background: var(--oc-primary); color: var(--oc-primary-fg); border-color: transparent; font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); }

  /* Notices */
  .stale { display: flex; align-items: center; gap: 0.55em; padding: 0.5em 0.75em; border-radius: 0.55em; background: var(--oc-hover); color: var(--oc-muted); }
  .stale-warn { background: color-mix(in srgb, var(--oc-warning) 14%, transparent); color: var(--oc-warning-text); }

  .info-wrap { display: inline-flex; align-items: center; cursor: help; flex-shrink: 0; outline: none; }
  .info-ico { color: var(--oc-muted); flex-shrink: 0; }
  .info-wrap:hover .info-ico, .info-wrap:focus-visible .info-ico { color: var(--oc-fg); }
  .tip { position: absolute; left: 12px; right: 12px; z-index: 20; padding: 0.55em 0.7em; border-radius: 0.5em; background: var(--oc-elevated); color: var(--oc-fg); border: 1px solid var(--oc-border); box-shadow: 0 4px 16px color-mix(in srgb, var(--oc-fg) 18%, transparent); font-size: 0.78em; line-height: 1.45; font-weight: 400; white-space: normal; opacity: 0; visibility: hidden; transition: opacity 0.12s ease; pointer-events: none; }
  .info-wrap:hover .tip, .info-wrap:focus-visible .tip { opacity: 1; visibility: visible; }

  .plugin-card { display: flex; flex-direction: column; gap: 0.6em; padding: 0.75em 0.9em; border-radius: 0.55em; background: var(--oc-elevated); border: 1px solid var(--oc-border); }
  .plugin-top { display: flex; align-items: center; justify-content: space-between; gap: 0.8em; }
  .plugin-id { display: flex; align-items: center; gap: 0.5em; min-width: 0; }
  .plugin-name { font-size: 0.9em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .plugin-right { display: flex; align-items: center; gap: 0.45em; flex-shrink: 0; }
  .plugin-note { display: flex; align-items: center; justify-content: space-between; gap: 0.7em; padding: 0.5em 0.6em; border-radius: 0.45em; background: color-mix(in srgb, var(--oc-warning) 12%, transparent); }
  .plugin-note.col { flex-direction: column; align-items: stretch; gap: 0.35em; }
  .inst-line { display: flex; align-items: center; justify-content: space-between; gap: 0.6em; }

  .footer { display: flex; flex-direction: column; gap: 0.8em; min-width: 0; flex-shrink: 0; margin-top: auto; padding-top: 0.4em; }
  .freshness { display: flex; align-items: center; justify-content: center; padding: 0.2em 0.15em 0.3em; }
  .linkbtn { font-size: 0.82em; font-weight: 500; color: var(--oc-primary-text); background: transparent; border: 0; padding: 0.2em 0.5em; border-radius: 0.4em; cursor: pointer; flex-shrink: 0; align-self: flex-start; }
  .linkbtn:hover { background: var(--oc-hover); }

  /* Very narrow rails: stack the hero ring above its figures. */
  @container (max-width: 300px) {
    .acc-body { flex-direction: column; align-items: flex-start; }
    .hit { grid-template-columns: auto minmax(0, 1fr) auto; }
    .hit .hit-sess { grid-column: 1 / -1; grid-row: 2; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; }
  }
`
