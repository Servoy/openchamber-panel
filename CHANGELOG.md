# Changelog

All notable changes to this panel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

### Added

- **New account card design.** A circular usage ring with the used percentage,
  credits left in large mono figures, and a recent daily-burn line — all using
  OpenChamber's own theme tokens so it matches light and dark.
- **Reset outlook.** Projects the recent daily burn over the days left until the
  reset and states the useful answer: credits to spare at reset, or how many
  short and the day you would run out. Colours warn at 85% used, critical at 95%
  or under ~200 credits left.
- **Collapsible Details** (plan, reset date, overage), remembered across reloads
  via `host.storage`; default collapsed.
- **Account pager** (chevrons + dots) when more than one Kiro account is signed
  in, replacing stacked cards.
- **Info tooltips** on the burn rate and the sessions heading, explaining how the
  estimates are computed (own CSS tooltip; the sandbox suppresses native `title`).
- **Persistent session titles.** The active session's title is remembered in
  `host.storage`, so a row keeps a readable name after a reload or restart rather
  than falling back to the raw session id.
- **Fixed footer.** Plugin version card and "Updated … ago" stay pinned at the
  bottom; only the session list scrolls.
- **Cache-busting build.** `npm run build` stamps `index.html`'s script URL so a
  rebuilt bundle is always a new URL.

### Changed

- **Daily burn is measured, not extrapolated.** The rate is credits from
  sessions in the last 7 days divided by the actually-measured span (floored at
  one day), shown as "≈ X cr/day · over Nh/Nd" so it never presents a few
  minutes of data as a settled weekly average.
- Session rows have a uniform height, hide the noisy `…/openchamber/chats/…`
  path of direct chats, and show a clear session name instead of the raw id.
- Secondary text now uses the host's `muted` token for readable contrast.

### Fixed

- **Empty panel after restart.** Overlapping paints (onReady, onSession, poll)
  raced on the repaint key and on clearing the DOM, which could leave the panel
  blank until data changed. Paints are now serialised and the repaint key is set
  only after the DOM is fully rendered.
- **Reset date / ETA no longer flickers away** when a usage sync omits the reset
  field: the last known reset time is retained (in the plugin and the panel).
- The panel renders immediately from an existing (even stale) snapshot; the npm
  version check no longer blocks the first paint.

## [1.0.2] and earlier

Initial panel: account usage (plan, credits, overage, reset), session request
estimates, running plugin instances with a version-split warning, and an npm
outdated-version check.
