# dsh-helux-tunnel

A DeepSeek Harness (DSH) plugin that turns a **pre-created, named Cloudflare
Tunnel** on and off from a **Helux Tunnel** panel in the left sidebar. When ON,
the tunnel publishes the local DSH Web UI at **https://helux.web.id**. When OFF,
DSH stays local at **http://127.0.0.1:3080**.

Version 2 adds a second button, **Copy launch URL**, which copies DSH's one-time
launch URL (`https://helux.web.id/?token=...`) from the token DSH keeps only in
memory, so the first public visit works without hunting through the terminal.
Version 2.1 adds **Pair device (QR)**, which shows that same launch URL as a QR
code for the Helux Android app.

The plugin is built for DSH `0.2.1-rc.5` and `0.2.2-rc.1` (Cordis plugin model,
Host services in Node, Client module in the Web page).

## Fixed tunnel definition (never changed by the plugin)

| Item | Value |
| --- | --- |
| Public hostname | `helux.web.id` (apex) |
| Public URL | `https://helux.web.id` |
| Local service | `http://127.0.0.1:3080` |
| Tunnel type | Named tunnel, already created by the user |
| Credentials | `~/.cloudflared/<tunnel-id>.json` |
| Tunnel config | `~/.cloudflared/config.yml` |
| Process | `cloudflared tunnel --config ~/.cloudflared/config.yml --no-autoupdate run <tunnel-id>` |

The plugin **never** creates a tunnel, **never** uses a quick tunnel
(`trycloudflare.com`), **never** generates a random URL, and **never** edits
`config.yml`, credentials, DNS, or Cloudflare Access policy.

## Default OFF — the core guarantee

- The tunnel is OFF at plugin load and at every DSH start/restart.
- Nothing auto-starts on DSH boot, plugin activation, browser reload, or HMR.
- The only ways to start it are the sidebar switch and the `tunnel_start` agent
  tool (which the agent may call only when you explicitly ask in chat).
- Pressing OFF sends `SIGTERM` to the `cloudflared` child, escalates to
  `SIGKILL` after 5 s if needed, and records the stop.
- Unloading the plugin or shutting DSH down kills the child process.
- State is persisted under `~/.dsh/data/helux-tunnel/state.json`, but every load
  forces it back to `enabled: false`; a previous ON is never resumed.
- The DSH launch token is never persisted. It exists only in DSH process memory,
  so OFF, dispose, and every DSH restart leave no token behind.
- Start/stop events, state transitions, captured `cloudflared` output, and
  Access checks are logged to `~/.dsh/logs/helux-tunnel.log` with ISO timestamps.

## Requirements

1. DSH Web profile (`dsh --profile web ...`) on `127.0.0.1:3080`.
2. The `cloudflared` binary on `PATH` (or `cloudflaredPath` set through the
   manager options).
3. An existing named tunnel with `~/.cloudflared/config.yml` and
   `~/.cloudflared/<tunnel-id>.json`.
4. The tunnel config must route `helux.web.id` to `http://127.0.0.1:3080`.

The plugin checks all four prerequisites before every start and shows every
missing one in the panel. It installs nothing.

## Install

```bash
# from a local checkout/directory
dsh plugin --profile web add /absolute/path/to/dsh-helux-tunnel

# or from a package registry, if published
dsh plugin --profile web add dsh-helux-tunnel
```

Then restart `dsh web` (or use the Plugins page in the Web sidebar). The
**Helux Tunnel** entry appears in the left sidebar.

> Build note: the package ships built `lib/` and `client.js`. Only rebuild after
> editing `src/`: `npm install && npm run build`.

## One-time tunnel and DSH setup

### 1. The named tunnel (already created by you)

If you ever need to recreate it, these are the standard commands — the plugin
does not run them:

```bash
cloudflared tunnel login
cloudflared tunnel create helux
cloudflared tunnel route dns helux helux.web.id
```

### 2. `~/.cloudflared/config.yml`

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/ubuntu/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: helux.web.id
    service: http://127.0.0.1:3080
  - service: http_status:404
```

The credentials JSON must already exist at
`~/.cloudflared/<tunnel-id>.json`. Keep both files readable only by you
(`chmod 600`).

### 3. Start DSH Web so it accepts the public authority

`cloudflared` forwards the public `Host` header by default, and DSH only accepts
loopback authorities unless told otherwise. Start DSH like this:

```bash
dsh --profile web --trusted-host helux.web.id --public-url https://helux.web.id
```

`--trusted-host helux.web.id` lets `/api` calls from the public page through the
Host/Origin fence. `--public-url` is optional but makes DSH advertise the public
URL. Restart DSH after changing either flag.

### 4. First public visit needs the launch token once

DSH binds its browser session cookie to the URL authority. Open the public URL
**once** with the launch token printed by `dsh web`:

```text
https://helux.web.id/?token=<launch-token>
```

That redirects to a clean `https://helux.web.id/` and mints the session cookie
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
- **ON**: the public URL `https://helux.web.id` with **Copy URL** and
  **Copy launch URL**, a masked launch preview (`?token=••••abcd`), uptime, the
  Cloudflare Access posture, and the last `cloudflared` log lines.
- **Copy launch URL** copies `https://helux.web.id/?token=<launch-token>` for a
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
`https://helux.web.id` from a browser without that cookie returns
`dsh web authentication required; reopen the URL printed by dsh web.` The launch
URL `https://helux.web.id/?token=<launch-token>` mints the cookie once and
redirects to the clean URL; after that, plain `https://helux.web.id` works.

The token source was investigated in this order, against DSH `0.2.1-rc.5` and
`0.2.2-rc.1`:

| Candidate | Finding |
| --- | --- |
| `dsh web` stdout | Prints `dsh web: https://helux.web.id/?token=...` at startup, but a loaded plugin cannot read the parent process's stdout. |
| `~/.dsh` state/session files | The token is **not** written to disk anywhere. |
| Local DSH endpoint | No shipped endpoint returns the launch token. |
| **Connection service (used)** | `ctx.get('connection').authenticatedUrl('https://helux.web.id')` from `@deepseek-ai/dsh-client-connection`. This is the same method `dsh-web-app` calls to print the startup URL. |

The token is DSH's `processLaunchToken`: 32 random bytes encoded as base64url,
generated once per DSH process and held in an in-memory `WeakMap` keyed by the
root context. DSH never persists it, and every DSH restart produces a new one.

How this plugin uses it:

- `src/index.ts` passes a lazy `resolveLaunchUrl` callback to the manager. It is
  resolved only when the panel asks, so a Connection reload is picked up and no
  copy survives in the plugin.
- `GET /api/helux-tunnel/status` returns only `launchUrlAvailable`,
  `launchUrlReason`, and the masked preview
  `https://helux.web.id/?token=••••abcd` (last four characters).
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
- When the panel itself is served through `https://helux.web.id`, the button is
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

- When ON, `https://helux.web.id` is **public unless Cloudflare Access is
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
│   │   ├── constants.ts    # fixed hostname, URLs, paths
│   │   ├── manager.ts      # cloudflared spawn, state, logs, launch URL masking
│   │   ├── prerequisites.ts# binary/config/credentials/port checks
│   │   └── redact.ts       # secret redaction
│   └── client/index.tsx    # sidebar entry + ON/OFF panel (React, TSX)
├── lib/                    # compiled Host entry (shipped)
├── client.js               # built Client module (shipped)
├── locale/en.json, zh.json # plugin metadata
├── icon.svg                # plugin icon
├── scripts/build.mjs       # tsc + Client-module wrapper
└── test/                   # fake-cloudflared, API, apply, and render tests
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
| `config.yml has no ingress entry for helux.web.id` | Add the `hostname: helux.web.id` / `service: http://127.0.0.1:3080` row. |
| `config.yml routes helux.web.id to …` | The service must be exactly `http://127.0.0.1:3080`. |
| `credentials file is missing` | Recreate/re-authorize the named tunnel; the JSON must be at `~/.cloudflared/<tunnel-id>.json`. |
| `Nothing is listening on 127.0.0.1:3080` | Start the DSH Web UI on port 3080 first. |
| `cloudflared did not register … within 20 seconds` | Credentials/network problem; see the log lines in the panel. |
| Page loads but stays disconnected | Restart DSH Web with `--trusted-host helux.web.id`, then reopen the launch URL once. |
| `Copy launch URL` is disabled | Hover the button or read the reason below it. OFF, a non-loopback page, a closed port 3080, or a DSH build without the Connection service all disable it. |
| `Token not found - open the URL printed by dsh web in its terminal` | DSH did not expose a launch token. Copy the tokenized URL from the `dsh web` terminal instead; the plain **Copy URL** button still works. |
| Launch URL copied but the page still says “authentication required” | The token is per DSH process and is bound to the authority. Make sure DSH runs with `--trusted-host helux.web.id`, copy again after a DSH restart, and open the copied URL in a private window. |
| `Tunnel error: … exited unexpectedly` | `cloudflared` stopped on its own; the panel keeps the exit detail and recent log. |

## Verification checklist

1. Start DSH with the plugin installed: the panel shows **OFF**, the launch
   button is disabled with its reason, and `pgrep -af cloudflared` shows no
   tunnel process started by the plugin.
2. Press **ON** with prerequisites met: status goes **CONNECTING**, then **ON**;
   `cloudflared tunnel run` is alive.
3. Click **Copy launch URL** and paste it into a private/incognito window. It
   must open the DSH UI directly, without “authentication required”. The panel
   shows only a masked preview and the “do not share” toast.
4. Close that tab and open plain `https://helux.web.id` in a normal tab. It must
   open directly because the cookie is already set.
5. Press **OFF**: the child exits, status returns to **OFF**, the launch button
   is disabled again, and `https://helux.web.id` is no longer reachable.
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