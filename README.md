# Kiro Usage — OpenChamber panel

A right-rail OpenChamber panel that shows AWS Kiro credit usage, read from the
snapshot written by the `@servoy/opencode-kiro-auth` OpenCode plugin.

```
you@example.com                (eu-central-1)   [KIRO POWER]
[##########                    ] 41% · 4,061.45 / 10,000
Remaining            5,938.55 credits
Resets               1 October 2026 (13d)
Until reset          13d 4h
Overage              $0.04/credit (disabled), cap 10,000
Used (this window)   +12.30 credits
Rate                 4.1 credits/h
At this rate, empty in   13d 2h
```

## How it works

The panel cannot reach AWS or read a bearer token — the OpenChamber sandbox
forbids both. Instead the plugin writes an account-usage snapshot to
`~/.config/opencode/kiro-usage.json` after every usage sync, and the panel reads
that file through the host's `readFile` (a declared `filesystem` permission for
that one path).

The snapshot carries the plan name, credits used/limit, overage rate/cap/status,
and the reset date. Every OpenCode project runs its own plugin instance against
the shared config directory, so the write is atomic (temp file + rename):
last-writer-wins is correct for a shared account total, and a reader never sees a
half-written file.

### Live burn

The panel remembers the first credit reading it sees per account and derives
"used this window", a credits/hour rate, and a rough ETA to the limit. This is
account-wide, not per-session.

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

Add `#v1.0.0` to the URL to pin a tag. A Git-URL install updates itself: choose
**Update** in Settings → Extensions once a newer version is published.

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
