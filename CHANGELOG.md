# Changelog

All notable changes to this panel are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0]

### Changed

- **Tokens are estimates, not exact.** Kiro sends no token counts; the plugin estimates output (~4 characters per token) and derives input from Kiro's context percentage. Labelled `est. · plugin`, shown with `~`. Cache read/write are hidden (always 0).
- **No more "exact" tags.** An unlabelled number is exact; only estimates carry `est.` or `~`. The scope ("this account") appears only when it changes the meaning.
- **Pace per working day** (Monday to Friday, 40-hour week). Order: Kiro's own counter (`counterDelta`, once it spans 3 days), then the exact month average. A partial `burn[].credits` is never read as a pace.
- **Credits per request** uses only sessions begun since the metering switch, and needs 50 requests.
- **Requests · 7d** is `burn[].requests`, exact per account over the whole window.
- **Pre-metering sessions** (begun before `meteredSince`) are dimmed with a note above the list and never marked "priciest".
- Key figures are two tiles (Requests, Credits / request); tool calls live in Tool usage and in a session's Tools header.
- `execute` carries a note: a Code Mode script is one call, the calls inside it are not counted.
- The last known `resetAt` per account is remembered, also across reloads, so a snapshot without it does not drop the projection.

### Removed

- Closest to compaction tile, Context window and Cost rank in the drill-down, "Most-used tool per session", per-row tool and context figures in the session list. OpenCode already shows context, and the rest repeated other sections.
- Duplicate wording: "all accounts" on tool calls and tokens, the token total in the heading, "not classified" and "no cost per tool" notes.

### Added

- Snapshot fields `creditsSource`, `meteredSince`, `burn[].creditsSince`, `counterDelta`, `counterSince` (see `panel/schema.ts`, CONTRACT v3).
- Tool lists in the session drill-down show 8 with "Show all".

## [1.3.0]

### Contract with the plugin (final)

- Tool calls and turn mix come from **OpenCode** (exact, summed over a session and its subagents, Kiro provider only); tokens are estimated by the plugin (corrected in 1.4.0); credits from **Kiro** (estimated). Each block is labelled with its source.
- `turns` is `{toolUse, answer, error}`; a failed turn shows in the session row and the drill-down.
- Context window is read **live from OpenChamber**, not from the file.
- Tokens are a single top-level total for all accounts (a message has no account id). Window labels come from `windowDays`.
- Removed from the contract: `contextPct`, `withReasoning`, `burn[].tokens`, `burn[].toolCalls`, `metered`, per-field `source`.
- The panel reads every candidate `kiro-usage.json` (`~/.config`, `%APPDATA%`, `~/.servoy`) and uses the newest.
- A removed account's share of a session stays visible (muted, "removed"); the session bar is split per account.

### Changed

- **Schema aligned with what the plugin can really fill.** `schema.ts` now labels every field EXACT/EST. and TODAY/SMALL/NEW, verified against `@servoy/opencode-kiro-auth` 2.10.0.
- **Tokens** (labelled exact here, corrected in 1.4.0): a Tokens section (session and 7-day) with input, cache read, cache write and output, cache reads shown on their own, and "from N of M requests" when Kiro did not report all of them.
- Added optional `sessions[].metered` (Kiro's own `meteringEvent` credits) and shown only when present.

### Removed

- Credits per tool, model, agent, `periodStartAt`, `estTokens` and `usedEnd`: the plugin has no realistic source for them. Tools are ranked by exact call count.
- "Needs plugin 2.3.0" copy (that version number was invented); missing sections now say what the plugin does not record yet.

## [1.2.0]

### Added

- **Insights.** Credits-per-day trend (7d/14d bars with average line and
  week-over-week change), tool usage (exact counts per tool, priciest tool calls
  per session), key figures (requests, tool calls, credits/request, fullest
  context), per-account overview, sortable sessions (cost, recent, requests,
  context) with a "priciest" marker.
- **Session drill-down.** Click a session (or a tool hit) for credits, requests,
  tool breakdown, context window, model/agent and which accounts served it.
  Esc or "All sessions" goes back.
- **Projections.** "Day N of M" with a credits-vs-time bar, and a plain verdict:
  lasts to the reset (credits to spare) or runs out in ~N days. Falls back to the
  period average (exact `used` ÷ days elapsed) when there is no recent burn.
- **Full-screen layout.** Two columns when the panel is wide, single column in the
  rail; sizing follows the container, not the window.
- **Account chips** replace the pager when several accounts are signed in.
- Stale-snapshot notice, and "not reported" in place of every missing value.

### Changed

- Every estimate is tagged `est.` / `~`; exact values are tagged `exact`.
  A missing field is shown as "not reported", never 0.
- Colours use only OpenChamber `--oc-*` tokens (no hex fallbacks).
- Source split into `schema.ts` (snapshot contract), `insights.ts` (pure logic),
  `ui.ts`, `styles.ts` and `main.ts`.

### Plugin contract

New optional snapshot fields (schema 2) are documented in `panel/schema.ts` and the
README. Older plugins keep working; the insight sections then say what is missing.

## [1.1.1]

### Fixed

- **Subagent sessions now show their real name.** Titles were learned only from
  the active session (`onSession`), so subagents — which never become active —
  all fell back to their directory name (e.g. every row read "svyCloud"), and a
  title only appeared while a row was clicked. The panel now subscribes to
  `onSessions` for every project and learns each session's title there, so all
  rows (subagents included) keep their real name across navigation and reloads.

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
