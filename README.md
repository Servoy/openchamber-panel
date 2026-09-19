# Kiro Usage — OpenChamber panel

A right-rail OpenChamber panel that shows AWS Kiro credit usage, read from the
snapshot written by the `@servoy/opencode-kiro-auth` OpenCode plugin.

The account card shows a usage ring, credits left, your recent daily burn, and
whether you will make it to the reset — with a collapsible Details section for
plan, reset date and overage, an account pager when more than one Kiro account is
signed in, a scrollable recent-sessions list, and a plugin-version footer.

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

### Daily burn and reset outlook

The panel sums the estimated credits of sessions active in the last 7 days and
divides by the time actually measured (never less than a day, so a single busy
hour is not read as a huge rate), giving an "≈ X cr/day" figure that settles into
a true weekly average as history accumulates. It projects that daily rate over
the days left until the reset and shows the useful answer: how many credits you
will have to spare at the reset, or how many short and the day you would run out.
The rate needs one message before it can exist; until then the card shows the
reset countdown. Colours warn at 85% used and turn critical at 95% or under ~200
credits left. All of it is theme-aware (OpenChamber's own colour tokens).

### Sessions (estimated)

Kiro bills per request (invocation), not per token, and its token counts are
unreliable — so there is no exact per-session cost. The plugin counts requests
per OpenCode session and apportions each account credit delta across the sessions
active in that window, by request share. The panel labels this as an estimate. On
a shared account, other users' usage mixes into the total.

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

Add `#v1.1.0` to the URL to pin a tag. A Git-URL install updates itself: choose
**Update** in Settings → Extensions once a newer version is published.

For a **folder install** (running from a local checkout), OpenChamber caches the
panel's iframe assets; after a rebuild, **Remove** the extension card and add the
folder again to be sure the new bundle loads.

The panel needs `@servoy/opencode-kiro-auth` **v2.2.0 or newer** active in
OpenCode, since that is the version that writes `kiro-usage.json`. Until then the
panel shows a "waiting for the plugin" notice with an update command.

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

- `filesystem` — reads only `~/.config/opencode/kiro-usage.json`.
- `sessions` — lists project sessions to highlight the active chat.
- `network` — checks the npm registry for the latest plugin version (public;
  no token needed).

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
