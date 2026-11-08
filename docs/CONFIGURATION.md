# Configuration

The plugin publishes one local DSH Web UI through **your own** Cloudflare
Tunnel. Nothing here is shared with the author: each deployment runs its own
`cloudflared`, uses its own tunnel credentials, and serves its own hostname.

There are two ways to configure it, and most people need only the first.

## Option 1: no plugin configuration at all (recommended)

If `~/.cloudflared/config.yml` already routes a hostname to your local DSH Web
UI, the plugin adopts that hostname automatically. You configure
`cloudflared`, not the plugin.

```yaml
tunnel: 8f3a1c2e-...
credentials-file: /home/you/.cloudflared/8f3a1c2e-....json

ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3080
  - service: http_status:404
```

The panel then shows `https://dsh.example.com` as the public URL. Nothing else
is required.

Auto-detection refuses to guess. It reports an error instead of picking one
when:

- no ingress row routes a hostname to the local service, or
- several hostnames route to the same local service (set `hostname` to choose).

## Option 2: configure the plugin explicitly

Add a row to your profile patch - `~/.dsh/profiles/<name>/cordis.patch.yml` on
Linux and macOS, `%USERPROFILE%\.dsh\profiles\<name>\cordis.patch.yml` on
Windows:

```yaml
- id: helux-tunnel
  config:
    hostname: dsh.example.com
```

| Option | Default | Meaning |
| --- | --- | --- |
| `hostname` | *(empty)* | Public hostname, bare (no `https://`, no path, no port). Empty means "adopt whatever `config.yml` publishes". |
| `localUrl` | `http://127.0.0.1:3080` | Local DSH Web UI the tunnel points at. Must be loopback. |
| `cloudflaredPath` | *(empty)* | Absolute path to the `cloudflared` binary. Empty means search `PATH` and the usual install directories. |
| `cloudflaredHome` | `~/.cloudflared` | Directory holding `config.yml` and the tunnel credentials JSON. `~` is expanded. |
| `accessCheck` | `true` | Probe the public hostname to report whether Cloudflare Access protects it. |

Invalid values fail at activation, so a typo appears in the plugin row instead
of producing a tunnel that starts and then serves the wrong name.

### Why `localUrl` must be loopback

The plugin refuses a non-loopback `localUrl`. Publishing someone else's server
through your tunnel is not a configuration this plugin supports, and the check
keeps a mistyped value from turning your tunnel into a proxy for a third party.

## Checklist

1. `cloudflared` is installed and on `PATH` (or set `cloudflaredPath`).
2. `cloudflared tunnel create <name>` has been run once, so credentials exist.
3. `config.yml` has an ingress row: your hostname to `http://127.0.0.1:3080`.
4. DNS is routed: `cloudflared tunnel route dns <name> <hostname>`.
5. DSH Web listens on `127.0.0.1:3080`.
6. DSH trusts the public authority:
   `dsh web --trusted-host <hostname> --public-url https://<hostname>`.

Step 6 is the one people miss. Without `--trusted-host`, the page loads but the
`/api` calls are rejected and the UI stays disconnected.

## Strongly recommended: put Cloudflare Access in front

The tunnel makes your DSH Web UI reachable from the internet. DSH's own
launch-token check is the only gate, and that token is per-process. Enable
Cloudflare Access for the hostname; the panel reports whether it detected an
Access redirect and never disables or bypasses it.

## Android app

The Android app is built for one hostname. If you use your own domain, change
[`HeluxConfig.kt`](../app/src/main/java/id/helux/dsh/HeluxConfig.kt) in the
[HeluxDsh](https://github.com/ywildan/HeluxDsh) repository and rebuild, or use
the browser instead - the panel's **Copy launch URL** button works everywhere.
