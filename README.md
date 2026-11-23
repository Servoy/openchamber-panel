# Kiro Usage — OpenChamber panel

A right-rail OpenChamber panel that shows AWS Kiro credit usage, read from the
snapshot written by the `@servoy/opencode-kiro-auth` OpenCode plugin.

The panel shows, per account: a usage ring, credits left, recent daily burn, "day
N of M" against credits used, and a verdict on whether you will make it to the
reset. Below that: key figures (requests, credits/request), tokens, tool usage, a
sortable session list and a per-session drill-down. It works in the narrow rail
and full-screen (two columns when wide), in light and dark.

## Exact, estimated, not reported

Kiro bills **per request, not per token**, and reports no cost per request, no
token counts and no cost per tool call. Credits exist only as an account total.
So every number is one of:

| Kind | Examples | Shown as |
| --- | --- | --- |
| Exact | requests, tool calls, turns, account credits/limit/reset, Kiro's own credit counter, the month average | plain, no tag |
| Estimated | tokens (by the plugin), credits per session, projections | `~` prefix and `est.` tag |
| Missing | any field the plugin did not write | `not reported` (never 0) |

An unlabelled number is exact. Tokens are **estimated by the plugin**: Kiro sends
none. Output is about 4 characters per token; input is Kiro's context percentage
times the model window the plugin assumes. They show where the budget went but do
not convert to credits. A Code Mode `execute` call counts as one tool call; the
calls inside the script are not recorded separately.

Sessions begun before the plugin metered credits per response (`meteredSince`)
carry overcounted credits. The panel dims them, marks them "pre-metering", and
never calls them "priciest".

## Snapshot schema (what the plugin writes)

The authoritative, commented contract is the header of [`panel/schema.ts`](panel/schema.ts)
("CONTRACT v2"), agreed between the panel and the plugin. Two sources feed the panel and every
number carries its source:

- **Kiro** (only the plugin knows it): credits, quota, overage, reset, requests, the credit counter,
  the per-session credits.
- **OpenCode** (the plugin reads it from OpenCode's own per-message data and copies a bounded
  aggregate into the file): tool calls, how each response ended, and the token estimates.

The file stays small by design (about 55 KB, however heavy the use): the top 50 sessions plus fixed-size aggregates.

| Field | Trust | Notes |
| --- | --- | --- |
| `accounts[]` (used, limit, pct, plan, overage, resetAt, …) | exact | Kiro |
| `sessions[]` top 50: `requests`, `firstUsed`, `lastUsed`, `directory`, `accounts[]` | exact | Kiro |
| `creditsSource: 'metered'`, `meteredSince` | exact | credits are booked per response from `meteredSince` on; absent on older plugins |
| `sessions[].estCredits` | metered, or estimate when `creditsSource` is absent | sessions begun before `meteredSince` are overcounted |
| `burn[]` per account: `windowDays`, `requests`, `earliestUsed` | exact | `requests` covers every session active in the window |
| `burn[].credits`, `creditsSince` | measured, a lower bound | only sessions begun after `meteredSince`; not a pace until a full window is metered |
| `burn[].counterDelta`, `counterSince` | exact | rise of Kiro's own `used` counter over the window; the pace once it spans 3 days |
| `sessions[].tokens` {uncachedInputTokens, outputTokens, …} | estimate | by the plugin, summed over the root session and its subagents, Kiro provider only |
| `sessions[].tools[]` {name, count}, `toolCalls` | exact | same scope |
| `sessions[].turns` {toolUse, answer, error} | exact | from each response's finish reason; a running response is not counted |
| `tokens` {…, windowDays} | estimate | all accounts together |
| `tools` {windowDays, totalCalls, items[]} | exact | all accounts together |
| `daily[]` | optional | the panel hides "Credits per day" when it is absent |
| `sessionsTotal`, `schema: 2` | exact | |

The panel detects what a plugin delivers from these fields, never from its version number.

Not in the file: **context %** (OpenCode shows it itself, so the panel does not), credits per tool,
model. Kiro reports no cache split, so cache read/write are hidden. Window labels ("7d") come from
`windowDays`, never hardcoded. Input tokens are the whole prompt of every request: they count tokens
processed, not tokens billed, and credits do not follow tokens (correlation 0.36 over 1,012 responses),
so the panel never converts one to the other.

Subagent sessions are booked under their root session, so a root's tokens and tools include its children.

## How it works

The panel cannot reach AWS or read a bearer token — the OpenChamber sandbox
forbids both. Instead the plugin writes an account-usage snapshot to
`~/.config/opencode/kiro-usage.json` (at startup and after every usage sync), and
the panel reads that file through the host's `readFile` (a declared `filesystem`
permission for that one path). Because the plugin seeds the file at startup, the
panel shows data — possibly slightly stale — immediately, without waiting for the
first message.

The snapshot carries the plan name, credits used/limit, overage rate/cap/status,
and the reset date. Every OpenCode project runs its own plugin instance against
the shared config directory, so the write is atomic (temp file + rename):
last-writer-wins is correct for a shared account total, and a reader never sees a
half-written file.

### Pace and reset outlook

Credits left and the reset date are exact and give a **budget per working day**.
Pace is counted per working day (Monday to Friday, a 40-hour week; weekends count
zero) and judged two ways: this month's average (credits used ÷ working days so
far, exact) and the last 7 days, from Kiro's own counter once it has been recorded
for 3 days. The period start is assumed to be one month before the reset. The card
says "lasts to the reset" (green) when both fit, "could run out" (amber) when they
disagree, and "runs out" when neither does. A pace measured over less than a full
window is never used: right after the metering switch it would say "plenty left".

### Sessions

Kiro reports credits only as an account total, so the plugin assigns credits to
sessions. Since `meteredSince` it meters them per response; older sessions were
apportioned by request share and run high, which the panel marks as "pre-metering".
On a shared account, other users' usage mixes into the total.

### Plugin instances

OpenCode loads a separate plugin instance per project, possibly from different
installs. The panel lists the running instances with their version and install
path, and warns when the pool is version-split so the outdated one can be found.

## Install

In OpenChamber: **Settings → Extensions**, paste the repository URL into the
**Folder, ZIP, or URL** field, choose **Add**, and approve the requested
permissions.

Use the **HTTPS** URL (the repository is public, so no SSH key or Git identity
is needed):

```
https://github.com/Servoy/openchamber-panel.git
```

Add `#v1.4.0` to the URL to pin a tag. A Git-URL install updates itself: choose
**Update** in Settings → Extensions once a newer version is published.

For a **folder install** (running from a local checkout), OpenChamber caches the
panel's iframe assets; after a rebuild, **Remove** the extension card and add the
folder again to be sure the new bundle loads.

The panel needs `@servoy/opencode-kiro-auth` **v2.11.0 or newer** active in
OpenCode: that is the version that meters credits per response and writes the fields
the panel relies on (`creditsSource`, `meteredSince`, `counterDelta`). Without a
snapshot the panel shows a "waiting for the plugin" notice with an update command.

The panel appears on the right rail and, because `page: true` is set, also
full-screen from the **Extension pages** menu.

## Troubleshooting

### "Could not clone that repository" / `POST /api/guests: HTTP 400`

Almost always a **local Git configuration problem on Windows**, not a problem
with this repository or OpenChamber. The most common cause is a Git for Windows
install whose system config forces an SSL backend the binary was not built with:

```
# system config (C:\Program Files\Git\etc\gitconfig) says:
http.sslBackend=openssl
# but the Git build only supports:
fatal: Unsupported SSL backend 'openssl'. Supported SSL backends: schannel
```

Git then exits non-zero on every HTTPS clone, and OpenChamber surfaces that as
`clone-failed → HTTP 400` with no further detail in its logs.

Fix it once, per user, by overriding the backend to the Windows-native one:

```powershell
git config --global http.sslBackend schannel
```

Then add the extension again in Settings → Extensions.

### It still won't clone

- You pasted the **SSH** URL (`git@github.com:...`). Use the HTTPS URL above; the
  repository is public and needs no key.
- A previous failed attempt is still shown — **Remove** the extension card in
  Settings → Extensions and add it again.
- On a **remote** OpenChamber instance the clone runs on the server, so the Git
  fix above must be applied there.

## Permissions

- `filesystem` — reads only `kiro-usage.json` (in `~/.config/opencode`, `%APPDATA%\opencode`
  or `~/.servoy/opencode`).
- `sessions` — lists project sessions to highlight the active chat.

The latest plugin version is delivered by the plugin in the snapshot, so the panel
needs no network access.

The Kiro token stays in the plugin and is never exposed to the panel.

## Build

Only needed when changing `panel/main.ts`. Commit the built `panel/main.js` —
OpenChamber does not compile TypeScript or install dependencies on install.

```
npm install
npm run build      # bundles panel/main.ts -> panel/main.js
npm run typecheck
```

Bump `version` in `package.json` to ship an update over a Git install.

## License

MIT
