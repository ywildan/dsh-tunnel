# dsh-helux-tunnel

A [DSH] (DSH) plugin that turns a **pre-created, named Cloudflare
Tunnel** on and off from a **Helux Tunnel** panel in the left sidebar. When ON,
the tunnel publishes the local DSH Web UI on **your own hostname**. When OFF,
DSH stays local at **http://127.0.0.1:3080**.

Version 2 adds a second button, **Copy launch URL**, which copies DSH's one-time
launch URL (`https://<your-host>/?token=...`) from the token DSH keeps only in
memory, so the first public visit works without hunting through the terminal.
Version 2.1 adds **Pair device (QR)**, which shows that same launch URL as a QR
code for the Helux Android app. Version 2.2 makes the hostname configurable and
runs on Windows as well as Linux and macOS.

The plugin is built for DSH `0.2.1-rc.5` and `0.2.2-rc.1` (Cordis plugin model,
Host services in Node, Client module in the Web page).

## Use your own domain

Nothing in this plugin is tied to the author's domain. Each deployment runs its
own `cloudflared` with its own tunnel and credentials, so no traffic ever passes
through anyone else's server.

With **no plugin configuration**, the plugin adopts whatever hostname your
tunnel's `config.yml` already publishes:

```yaml
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3080
  - service: http_status:404
```

To be explicit, or to choose among several ingress rows:

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: helux-tunnel
  config:
    hostname: dsh.example.com
```

| Option | Default | Meaning |
| --- | --- | --- |
| `hostname` | *(auto)* | Public hostname, bare. Empty adopts the one in `config.yml`. |
| `localUrl` | `http://127.0.0.1:3080` | Local DSH Web UI. Must be loopback. |
| `cloudflaredPath` | *(PATH)* | Absolute path to the binary. |
| `cloudflaredHome` | `~/.cloudflared` | Directory with `config.yml` and credentials. |
| `accessCheck` | `true` | Probe the public hostname for Cloudflare Access. |

Full guide: **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**.
Windows: **[docs/WINDOWS.md](docs/WINDOWS.md)**.

## Platform support

| Platform | Status |
| --- | --- |
| Linux | Supported |
| macOS | Supported |
| Windows 10/11 | Supported - see [docs/WINDOWS.md](docs/WINDOWS.md) |

The Host half is plain Node.js with no native modules. Windows differences that
are handled for you: `taskkill /T` instead of `SIGTERM` (Windows has no
signals, and `/T` is what stops a wrapper's grandchild), `.exe`/`.com`-only
binary resolution (a `.cmd` cannot be spawned without a shell), quoted `PATH`
entries, and `%USERPROFILE%` path display. Those rules live in
`src/host/platform.ts` and are tested on every platform, not just Windows.

## What the plugin does and does not touch

| Item | Value |
| --- | --- |
| Public hostname | Yours - from plugin config, else from `config.yml` |
| Local service | `http://127.0.0.1:3080` by default, loopback only |
| Tunnel type | Named tunnel, already created by you |
| Credentials | `<cloudflared-home>/<tunnel-id>.json` |
| Tunnel config | `<cloudflared-home>/config.yml` |
| Process | `cloudflared tunnel --config <config.yml> --no-autoupdate run <tunnel-id>` |

The plugin **never** creates a tunnel, **never** uses a quick tunnel
(`trycloudflare.com`), **never** generates a random URL, and **never** edits
`config.yml`, credentials, DNS, or Cloudflare Access policy.

## Default OFF — the core guarantee

- The tunnel is OFF at plugin load and at every DSH start/restart.
- Nothing auto-starts on DSH boot, plugin activation, browser reload, or HMR.
- The only ways to start it are the sidebar switch and the `tunnel_start` agent
  tool (which the agent may call only when you explicitly ask in chat).
- Pressing OFF terminates the `cloudflared` child: `SIGTERM` then `SIGKILL` on
  Linux and macOS, `taskkill /T` then `/T /F` on Windows, which also stops any
  wrapper's grandchild. The stop is recorded either way.
- Unloading the plugin or shutting DSH down kills the child process.
- State is persisted under `~/.dsh/data/helux-tunnel/state.json`, but every load
  forces it back to `enabled: false`; a previous ON is never resumed.
- The DSH launch token is never persisted. It exists only in DSH process memory,
  so OFF, dispose, and every DSH restart leave no token behind.
- Start/stop events, state transitions, captured `cloudflared` output, and
  Access checks are logged to `~/.dsh/logs/helux-tunnel.log` with ISO timestamps.

## Requirements

1. DSH Web profile (`dsh --profile web ...`) on `127.0.0.1:3080`.
2. The `cloudflared` binary on `PATH`, or `cloudflaredPath` in the plugin config.
3. An existing named tunnel with `config.yml` and `<tunnel-id>.json` in
   `~/.cloudflared` (or `cloudflaredHome`).
4. The tunnel config must route **your** hostname to the local DSH Web UI.

The plugin checks all five prerequisites before every start and shows every
missing one in the panel. It installs nothing. The fifth, **DSH host trust**,
asks this DSH instance whether it accepts your public hostname on `/api`; see
[Configuration](docs/CONFIGURATION.md) for why that matters.

## Install

Straight from GitHub - this is the supported path today, and it needs no build
step because the compiled `lib/` and `client.js` are committed:

```bash
dsh plugin --profile web add github:ywildan/dsh-tunnel
```

Or from a local checkout:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-helux-tunnel
```

Then restart `dsh web`. The **Helux Tunnel** entry appears in the left sidebar.

> `dsh plugin add dsh-helux-tunnel` (bare package name) does **not** work yet:
> the package is not published to npm. Use the `github:` spec above.

### For an agent installing this

An agent can run the `add` command itself, but two steps need the human:

1. **`cloudflared tunnel login`** opens a browser and asks which zone to
   authorize. That is a domain-ownership decision and cannot be delegated.
2. **Restarting `dsh web`** with `--trusted-host` and `--public-url`.

Everything else - installing the plugin, writing `config.yml`, creating the
tunnel, routing DNS - the agent can do.

> Build note for contributors: `lib/` and `client.js` are committed because the
> git install never rebuilds them. After editing `src/`, run
> `npm run build` and commit the output; `npm run check` (and CI) fails if the
> committed output does not match `src/`.

## One-time tunnel and DSH setup

### 1. The named tunnel (already created by you)

If you ever need to recreate it, these are the standard commands — the plugin
does not run them:

```bash
cloudflared tunnel login
cloudflared tunnel create helux
cloudflared tunnel route dns helux <host>
```

### 2. `~/.cloudflared/config.yml`

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<you>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: <host>
    service: http://127.0.0.1:3080
  - service: http_status:404
```

The credentials JSON must already exist at
`<cloudflared-home>/<tunnel-id>.json`. Keep both files readable only by you
(`chmod 600`; on Windows, restrict the file's ACL to your account). On Windows
the same files live under `%USERPROFILE%\.cloudflared` - see
[docs/WINDOWS.md](docs/WINDOWS.md).

### 3. Start DSH Web so it accepts the public authority

`cloudflared` forwards the public `Host` header by default, and DSH only accepts
loopback authorities unless told otherwise. Start DSH like this:

```bash
dsh --profile web --trusted-host <host> --public-url https://<host>
```

`--trusted-host <host>` lets `/api` calls from the public page through the
Host/Origin fence. `--public-url` is optional but makes DSH advertise the public
URL. Restart DSH after changing either flag.

### 4. First public visit needs the launch token once

DSH binds its browser session cookie to the URL authority. Open the public URL
**once** with the launch token printed by `dsh web`:

```text
https://<host>/?token=<launch-token>
```

That redirects to a clean `https://<host>/` and mints the session cookie
for that authority. Do not share or commit that tokenized URL; it grants access
to this DSH instance. Without Cloudflare Access, anyone who obtains it (or the
cookie) can use the UI.

With this plugin installed you do **not** need to copy that URL from the
terminal: press **Copy launch URL** in the panel (see below).

## Using the panel

The sidebar entry opens **Helux Tunnel** in the main column:

- **Large ON/OFF switch**, OFF by default.
- Status: **OFF** (grey), **CONNECTING** (yellow + spinner), **ON** (green),
  **ERROR** (red).
- **OFF** message: “Tunnel is OFF. DSH is only accessible locally at
  http://127.0.0.1:3080”.
- **ON**: the public URL `https://<host>` with **Copy URL** and
  **Copy launch URL**, a masked launch preview (`?token=••••abcd`), uptime, the
  Cloudflare Access posture, and the last `cloudflared` log lines.
- **Copy launch URL** copies `https://<host>/?token=<launch-token>` for a
  first visit in a private/incognito window. It never opens the URL itself and
  is disabled when the tunnel is OFF, the local page is not loopback, the local
  DSH Web is down, or DSH cannot expose its token. Each success shows
  **“Launch URL copied - do not share, it is like a password”**.
- **OFF**: the launch button is visible but disabled with the reason
  **“Tunnel is OFF. Turn it ON to copy the launch URL.”**
- **Prerequisites** list with the exact reason and hint for each failure.
- **ERROR** shows why the start failed. A failed start never spawns silently:
  the panel turns red and the reason is reported.

The switch is a real `role="switch"` control with keyboard support. All text is
localized (English and Chinese).

## Copy launch URL: where the token comes from

DSH binds its browser-session cookie to the request authority. A plain visit to
`https://<host>` from a browser without that cookie returns
`dsh web authentication required; reopen the URL printed by dsh web.` The launch
URL `https://<host>/?token=<launch-token>` mints the cookie once and
redirects to the clean URL; after that, plain `https://<host>` works.

The token source was investigated in this order, against DSH `0.2.1-rc.5` and
`0.2.2-rc.1`:

| Candidate | Finding |
| --- | --- |
| `dsh web` stdout | Prints `dsh web: https://<host>/?token=...` at startup, but a loaded plugin cannot read the parent process's stdout. |
| `~/.dsh` state/session files | The token is **not** written to disk anywhere. |
| Local DSH endpoint | No shipped endpoint returns the launch token. |
| **Connection service (used)** | `ctx.get('connection').authenticatedUrl('https://<host>')` from `@deepseek-ai/dsh-client-connection`. This is the same method `dsh-web-app` calls to print the startup URL. |

The token is DSH's `processLaunchToken`: 32 random bytes encoded as base64url,
generated once per DSH process and held in an in-memory `WeakMap` keyed by the
root context. DSH never persists it, and every DSH restart produces a new one.

How this plugin uses it:

- `src/index.ts` passes a lazy `resolveLaunchUrl` callback to the manager. It is
  resolved only when the panel asks, so a Connection reload is picked up and no
  copy survives in the plugin.
- `GET /api/helux-tunnel/status` returns only `launchUrlAvailable`,
  `launchUrlReason`, and the masked preview
  `https://<host>/?token=••••abcd` (last four characters).
- `POST /api/helux-tunnel/launch-url` returns the full URL only to a loopback
  request without Cloudflare/proxy headers. The Client copies it and discards
  it; it is not kept in React state.
- The full token is never logged, never written to
  `~/.dsh/data/helux-tunnel/state.json` or
  `~/.dsh/logs/helux-tunnel.log`, and never rendered in the UI.
- Nothing tokenized is cached on the Host: OFF clears availability and the
  preview, dispose drops the manager, and a DSH restart starts from a fresh
  process token.

Availability and fallback:

- The button is enabled only when the tunnel is **ON**, DSH Web answers on
  `http://127.0.0.1:3080`, the token resolves, and the page was loaded from a
  loopback address. It copies only on an explicit click and never auto-opens.
- If DSH cannot expose a token (for example a build without the Connection
  service), the button is disabled and the panel shows
  **“Token not found - open the URL printed by dsh web in its terminal”**.
  Plain **Copy URL** keeps working.
- While OFF, the button is disabled with
  **“Tunnel is OFF. Turn it ON to copy the launch URL.”**
- When the panel itself is served through `https://<host>`, the button is
  disabled because the token endpoint is local-only; use
  `http://127.0.0.1:3080` for tunnel control.

## Pair an Android device (QR)

The **Pair device (QR)** button in the URL row renders the launch URL as a QR
code, so the Helux DSH Android app can pair by scanning instead of
typing.

- It is enabled under exactly the same conditions as **Copy launch URL**: tunnel
  **ON**, DSH Web answering on `127.0.0.1:3080`, a resolvable token, and a page
  loaded from a loopback address.
- The QR is drawn **only after an explicit click**, never on load, and it
  **hides itself after 60 seconds** (plus a close button).
- Only the QR matrix and the masked preview stay in memory. The URL string is
  dropped immediately after the matrix is built, and nothing is written to disk.
- The panel shows **“This QR contains the launch token - treat it like a
  password. Do not photograph or share it.”** next to the code.
- The QR encoder is vendored (`src/client/qrcode.ts`, `qrcode-generator` 1.4.4,
  MIT) because the Client bundle may only `require("react")`. `test/qr.test.mjs`
  proves the matrices are bit-identical to the reference library and that
  `jsQR` decodes them back to the exact launch URL.
- While OFF, the button is visible but disabled, like **Copy launch URL**.

What the app gets from a scan: the same one-time visit. DSH exchanges the token
for a cookie signed with the persistent browser-session secret, so the device
stays paired for the cookie lifetime (**`cookieMaxAgeDays`, 30 days by default**)
and survives DSH restarts. The token itself is per-process, so a QR is only
valid until DSH restarts.

## Security behavior

- When ON, `https://<host>` is **public unless Cloudflare Access is
  enabled**. The panel states that and adds **“Warning: public without Access
  policy”** when its public-URL probe sees an unprotected response.
- The plugin never disables, bypasses, or weakens Cloudflare Access. If Access
  redirects the probe to `*.cloudflareaccess.com` (or answers 401/403), the panel
  reports that Access appears to be protecting the hostname.
- Credentials, tunnel secrets, API tokens, and the DSH launch token are never
  displayed in the UI, the tools, or the log. Log lines are redacted: long
  secret/UUID-shaped tokens and `token=`/`secret:`-style values become
  `[redacted]`.
- The launch URL is masked everywhere except the clipboard: the UI shows only
  `?token=••••abcd` (last four characters). The full value is returned once by
  the local-only `POST /api/helux-tunnel/launch-url`, copied, and discarded. It
  is never persisted, and a copy toast warns that it is like a password.
- Control endpoints (`/api/helux-tunnel/start`, `/stop`, `/access-check`,
  `/launch-url`) accept only loopback requests (`Host: 127.0.0.1`, `localhost`,
  `::1`, etc.) and reject any request carrying Cloudflare/proxy forwarding
  headers. Read-only status is available through the tunnel; mutations and the
  launch token are not.
- Starting/stopping does not create or modify any Cloudflare resource.

## Agent tools

| Tool | Behavior |
| --- | --- |
| `tunnel_start` | Turns the tunnel ON. The description requires an explicit user request in chat; the agent must not call it on its own, on startup, after restarts, or just to check state. Fails with the missing prerequisite when the setup is incomplete. |
| `tunnel_stop` | Turns the tunnel OFF, kills `cloudflared`, and is safe when already OFF. |
| `tunnel_status` | Reports OFF/CONNECTING/ON/ERROR, public URL, Access posture, prerequisites, and the last log lines without changing anything. |

The sidebar toggle is the primary control; the tools call the same Host manager,
so the UI and the tools cannot disagree.

## Files

```text
dsh-helux-tunnel/
├── package.json            # bundle + dsh.client manifest
├── cordis.patch.yml        # inserts the Host row
├── src/
│   ├── index.ts            # Host entry: tools, HTTP bridge, launch-token callback
│   ├── host/
│   │   ├── api.ts          # local-only /api/helux-tunnel bridge
│   │   ├── config.ts       # Config schema, validation, hostname rules
│   │   ├── constants.ts    # defaults, URLs, paths
│   │   ├── manager.ts      # cloudflared spawn, state, logs, launch URL masking
│   │   ├── platform.ts     # Windows/POSIX rules (binary, PATH, termination)
│   │   ├── prerequisites.ts# binary/config/credentials/port checks
│   │   └── redact.ts       # secret redaction
│   └── client/index.tsx    # sidebar entry + ON/OFF panel (React, TSX)
├── lib/                    # compiled Host entry (shipped)
├── client.js               # built Client module (shipped)
├── docs/
│   ├── CONFIGURATION.md    # every option, plus the no-config path
│   └── WINDOWS.md          # Windows setup and differences
├── locale/en.json, zh.json # plugin metadata
├── icon.svg                # plugin icon
├── scripts/build.mjs       # tsc + Client-module wrapper
└── test/                   # fake-cloudflared, API, apply, render, platform tests
```

## Build and test

```bash
npm install          # devDependencies only: typescript, @types/*, qrcode-generator, jsqr
npm run build
npm test
```

`scripts/build.mjs` compiles the Host half with `tsc` to `lib/`, compiles the
single-file Client half with `tsc` to `.build/client/`, flattens the vendored QR
encoder into the bundle, rejects any `require` other than `react`, and wraps the
result in `window.__ModuleLoader__.load({ id, factory })` as `client.js`.

`qrcode-generator` and `jsqr` are **dev-only**: the first is the reference the
vendored encoder must match, the second is a real decoder used to prove the
generated code is scannable. Neither ships to the browser.

## Troubleshooting

| Panel says | Meaning / fix |
| --- | --- |
| `cloudflared is not installed or not on PATH` | Install `cloudflared`, then restart DSH. |
| `Cloudflare Tunnel config not found` | Create `~/.cloudflared/config.yml` with the ingress shown above. |
| `config.yml has no ingress entry for <host>` | Add the `hostname: <host>` / `service: http://127.0.0.1:3080` row. |
| `config.yml routes <host> to …` | The service must be exactly `http://127.0.0.1:3080`. |
| `credentials file is missing` | Recreate/re-authorize the named tunnel; the JSON must be at `~/.cloudflared/<tunnel-id>.json`. |
| `Nothing is listening on 127.0.0.1:3080` | Start the DSH Web UI on port 3080 first. |
| `cloudflared did not register … within 20 seconds` | Credentials/network problem; see the log lines in the panel. |
| Page loads but stays disconnected | Restart DSH Web with `--trusted-host <host>`, then reopen the launch URL once. |
| Chat renders, but picking a folder fails with `transport failure for /api/directoryPicker/list: HTTP 403` | Same cause: DSH's `/api` fence rejected the public Host. The HTML is served without a trust check, so the page looks fine while every API call is refused. Restart with `--trusted-host <host>`; the **DSH host trust** preflight item now reports this before you turn the tunnel ON. |
| `Copy launch URL` is disabled | Hover the button or read the reason below it. OFF, a non-loopback page, a closed port 3080, or a DSH build without the Connection service all disable it. |
| `Token not found - open the URL printed by dsh web in its terminal` | DSH did not expose a launch token. Copy the tokenized URL from the `dsh web` terminal instead; the plain **Copy URL** button still works. |
| Launch URL copied but the page still says “authentication required” | The token is per DSH process and is bound to the authority. Make sure DSH runs with `--trusted-host <host>`, copy again after a DSH restart, and open the copied URL in a private window. |
| `Tunnel error: … exited unexpectedly` | `cloudflared` stopped on its own; the panel keeps the exit detail and recent log. |

## Verification checklist

1. Start DSH with the plugin installed: the panel shows **OFF**, the launch
   button is disabled with its reason, all five prerequisite items are green,
   and `pgrep -af cloudflared` shows no tunnel process started by the plugin.
2. Press **ON** with prerequisites met: status goes **CONNECTING**, then **ON**;
   `cloudflared tunnel run` is alive.
3. Click **Copy launch URL** and paste it into a private/incognito window. It
   must open the DSH UI directly, without “authentication required”. The panel
   shows only a masked preview and the “do not share” toast.
4. Close that tab and open plain `https://<host>` in a normal tab. It must
   open directly because the cookie is already set.
5. Press **OFF**: the child exits, status returns to **OFF**, the launch button
   is disabled again, and `https://<host>` is no longer reachable.
6. Restart DSH: the panel is **OFF** again, nothing starts by itself, and no
   token from the previous process is available.
7. With no token source (or from the tunneled page), **Copy launch URL** is
   disabled with the documented reason instead of copying a broken URL.
8. Press **Pair device (QR)**: a QR appears next to the masked preview, with the
   do-not-share warning. Scan it with the Helux Android app; the phone opens the
   DSH UI. Wait 60 seconds without scanning: the QR disappears by itself.

Automated coverage (`npm test`) includes the masked preview, the full URL only
on the local endpoint, rejection of tunneled launch-token requests, absence of
the token from the state and log files, the OFF/token-missing fallbacks, and -
for the QR - that the vendored encoder is bit-identical to `qrcode-generator`
1.4.4, that `jsQR` decodes a rendered matrix back to the exact launch URL, and
that the full URL never appears in the rendered panel tree.

> Verification note: the automated suite uses a fake `cloudflared` so it runs
> anywhere, including the missing-prerequisite path. On the machine that holds
> the real named tunnel (`<TUNNEL_ID>`), the launch-URL
> flow was also verified live: the local endpoint returned the correct URL
> shape, the token exchanged for a `dsh-auth-` cookie (303, then 200 on the
> clean URL), an unauthenticated request still received DSH's 401, a tunneled
> `POST /launch-url` was refused with 403, and the token appeared in neither
> `state.json` nor `helux-tunnel.log`. The masked preview and the full token were
> never printed during that check.

## License

[MIT](LICENSE). Use it, fork it, ship it on your own domain.
