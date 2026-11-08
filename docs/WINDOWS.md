# Windows

The plugin runs on Windows as well as Linux and macOS. The Host half is plain
Node.js, so nothing needs to be compiled. This page lists what differs.

## Requirements

- **Windows 10 or 11**, 64-bit.
- **Node.js 20 or newer** - whatever DSH itself requires.
- **`cloudflared` for Windows** - one of:

```powershell
winget install --id Cloudflare.cloudflared
```

```powershell
# or with Scoop
scoop install cloudflared
```

The official installer puts `cloudflared.exe` in
`C:\Program Files\cloudflared\` and adds it to `PATH`. The plugin also searches
that directory, `%LOCALAPPDATA%\Microsoft\WinGet\Links`, and
`%USERPROFILE%\scoop\shims`, so a GUI-launched DSH that inherited a minimal
`PATH` still finds it.

## Paths

| Linux / macOS | Windows |
| --- | --- |
| `~/.cloudflared/config.yml` | `%USERPROFILE%\.cloudflared\config.yml` |
| `~/.cloudflared/<tunnel-id>.json` | `%USERPROFILE%\.cloudflared\<tunnel-id>.json` |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | `%USERPROFILE%\.dsh\profiles\<name>\cordis.patch.yml` |
| `~/.dsh/logs/helux-tunnel.log` | `%USERPROFILE%\.dsh\logs\helux-tunnel.log` |

`~` is expanded for you, in the plugin config and in `config.yml`.

## Create the tunnel on Windows

Run these in PowerShell. They are the same commands as on Linux; only the
paths differ.

```powershell
cloudflared tunnel login
cloudflared tunnel create helux
cloudflared tunnel route dns helux dsh.example.com
```

Then create `%USERPROFILE%\.cloudflared\config.yml`. **Use forward slashes** in
the `credentials-file` value - `cloudflared` accepts them on Windows and they
avoid YAML escaping problems with backslashes:

```yaml
tunnel: 8f3a1c2e-...
credentials-file: C:/Users/you/.cloudflared/8f3a1c2e-....json

ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3080
  - service: http_status:404
```

Start DSH Web with the trusted host:

```powershell
dsh web --trusted-host dsh.example.com --public-url https://dsh.example.com
```

Open `http://127.0.0.1:3080`, open the **Helux Tunnel** panel, and turn it ON.

## What is different under the hood

These are handled for you; they are listed so a failure is diagnosable.

- **No signals.** Windows has no `SIGTERM`. Node maps `kill()` to
  `TerminateProcess`, so turning the tunnel OFF uses
  `taskkill /pid <pid> /T` and then `/T /F`. `/T` matters: without it a wrapper
  process can leave a grandchild holding the tunnel open while the panel already
  says OFF.
- **Binary resolution.** Only `.exe` and `.com` are accepted. `.cmd` and `.bat`
  are skipped on purpose: Node cannot start a batch file without a shell, so
  resolving one would turn "not found" into an opaque `EINVAL` at start time.
- **Quoted `PATH` entries.** A `PATH` entry containing a space arrives quoted;
  the quotes are stripped before use.
- **Path display.** `%USERPROFILE%` is collapsed to `~` using the Windows
  separator, so error messages stay readable.

## Troubleshooting

**The panel says cloudflared is not installed.**
Open a new terminal after installing and run `cloudflared --version`. If that
works but the panel still fails, set `cloudflaredPath` to the absolute path:

```yaml
- id: helux-tunnel
  config:
    cloudflaredPath: C:\Program Files\cloudflared\cloudflared.exe
```

**`config.yml has no ingress entry for …`**
The hostname in the plugin config and the hostname in `config.yml` must match
exactly. Leave `hostname` unset to have the plugin adopt the one in
`config.yml`.

**The tunnel turns ON but the page stays disconnected.**
DSH was not started with `--trusted-host <hostname>`. See
[CONFIGURATION.md](CONFIGURATION.md).

**The tunnel stays ON after DSH closes.**
A leftover `cloudflared.exe` can be killed with:

```powershell
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
```
