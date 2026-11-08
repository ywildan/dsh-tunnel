import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { binDirectories, collapseHome, executableExtensions, pathDirectories } from './platform.js'
import { join } from 'node:path'

/** Fixed inputs the plugin is allowed to use, plus test-only path overrides. */
export interface TunnelSettings {
  /** Explicit `cloudflared` binary; otherwise PATH is searched. */
  cloudflaredPath?: string
  /** Directory holding `config.yml` and `<tunnel-id>.json`. */
  cloudflaredHome: string
  /** DSH home that owns the plugin's log and state files. */
  dshHome: string
  /** Public hostname the tunnel must publish. */
  hostname: string
  /** Local service the tunnel ingress must target. */
  localUrl: string
}

/** One ingress row parsed from `config.yml`. */
export interface IngressRule {
  hostname?: string
  service?: string
}

/** The parts of `config.yml` this plugin validates before spawning. */
export interface TunnelConfig {
  configPath: string
  tunnelId: string
  credentialsFile: string
  ingress: IngressRule[]
}

/** How long the trust probe may take before it is reported as unverified. */
const PROBE_TIMEOUT_MS = 4_000

/** Result of one preflight check. */
export interface PrerequisiteCheck {
  id: 'cloudflared' | 'config' | 'credentials' | 'port' | 'trust'
  ok: boolean
  message: string
  hint?: string
}

/** Complete preflight report, including the parsed config on success. */
export interface PrerequisiteReport {
  ok: boolean
  checks: PrerequisiteCheck[]
  config?: TunnelConfig
  /** Hostname the tunnel actually publishes, taken from config.yml. */
  hostname?: string
  binary?: string
  checkedAt: number
}

/** Port derived from the configured local URL. */
export function localPort(localUrl: string): number {
  const parsed = new URL(localUrl)
  if (parsed.port.length > 0) return Number(parsed.port)
  return parsed.protocol === 'https:' ? 443 : 80
}

/**
 * Render a filesystem path with the user's home collapsed to `~`.
 * @param path - absolute path.
 * @returns display-safe path text.
 */
export function displayPath(path: string): string {
  return collapseHome(path, homedir())
}

/**
 * Expand a leading `~` and strip one layer of matching quotes.
 * @param raw - YAML scalar text.
 * @returns the normalized scalar.
 */
function scalar(raw: string): string {
  const trimmed = raw.trim()
  const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed
  // Both separators: a config.yml copied from a Windows machine uses `~\`.
  if (unquoted === '~') return homedir()
  if (unquoted.startsWith('~/') || unquoted.startsWith('~\\')) return join(homedir(), unquoted.slice(2))
  return unquoted
}

/**
 * Remove a YAML inline comment while respecting quoted scalars.
 * @param line - one raw config line.
 * @returns the line without its trailing comment.
 */
function stripComment(line: string): string {
  let quote: string | undefined
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '#' && (index === 0 || /\s/.test(line[index - 1] ?? ''))) return line.slice(0, index)
  }
  return line
}

/**
 * Parse the small subset of `config.yml` the tunnel needs: the tunnel id, the
 * credentials path, and the ingress hostname/service mapping.
 *
 * A full YAML parser would be a runtime dependency for four keys; this reader
 * accepts the shapes `cloudflared tunnel create` writes and rejects anything it
 * cannot classify instead of guessing.
 * @param text - raw `config.yml` contents.
 * @param settings - fixed paths and hostname.
 * @returns the parsed config or the reason it is unusable.
 */
export function parseTunnelConfig(
  text: string,
  settings: TunnelSettings,
): { config?: TunnelConfig; hostname?: string; error?: string } {
  const rows = text.split(/\r?\n/)
  let tunnelId = ''
  let credentialsFile = ''
  let ingressStart = -1

  for (let index = 0; index < rows.length; index += 1) {
    const line = stripComment(rows[index] ?? '')
    if (line.trim().length === 0) continue
    const indent = line.length - line.trimStart().length
    if (indent !== 0) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const key = match[1] ?? ''
    const value = match[2] ?? ''
    if (key === 'tunnel' && value.trim().length > 0) tunnelId = scalar(value)
    else if (key === 'credentials-file' && value.trim().length > 0) credentialsFile = scalar(value)
    else if (key === 'ingress') ingressStart = index + 1
  }

  const ingress: IngressRule[] = []
  if (ingressStart >= 0) {
    let current: IngressRule | undefined
    for (let index = ingressStart; index < rows.length; index += 1) {
      const line = stripComment(rows[index] ?? '')
      if (line.trim().length === 0) continue
      const indent = line.length - line.trimStart().length
      if (indent === 0) break
      const content = line.trim()
      if (content === '-' || content.startsWith('- ') || content.startsWith('-\t')) {
        if (current !== undefined) ingress.push(current)
        current = {}
        const rest = content.slice(1).trim()
        if (rest.length > 0) assignIngress(current, rest)
        continue
      }
      if (current !== undefined) assignIngress(current, content)
    }
    if (current !== undefined) ingress.push(current)
  }

  if (tunnelId.length === 0) {
    return { error: `config.yml does not declare a "tunnel:" id.` }
  }
  if (ingress.length === 0) {
    return { error: `config.yml has no "ingress:" rules.` }
  }

  const expected = normalizeService(settings.localUrl)
  const configured = settings.hostname.toLowerCase()

  // Which ingress row this plugin will use.
  //
  // With no configured hostname the plugin adopts the tunnel's own ingress, so
  // a user who already set up `cloudflared` needs no plugin configuration at
  // all. Rows without a hostname are catch-alls (`http_status:404`) and are
  // never candidates.
  const candidates = ingress.filter((entry) => (entry.hostname ?? '').length > 0)
  let rule: IngressRule | undefined
  if (configured.length > 0) {
    rule = candidates.find((entry) => (entry.hostname ?? '').toLowerCase() === configured)
    if (rule === undefined) {
      const known = candidates.map((entry) => entry.hostname).join(', ')
      return {
        error: `config.yml has no ingress entry for ${settings.hostname}.${known === '' ? '' : ` It declares: ${known}.`}`,
      }
    }
  } else {
    const matching = candidates.filter((entry) => normalizeService(entry.service ?? '') === expected)
    if (matching.length === 0) {
      return {
        error: `config.yml has no ingress entry routing a hostname to ${settings.localUrl}. Set the plugin's "hostname" option, or point an ingress row at ${settings.localUrl}.`,
      }
    }
    if (matching.length > 1) {
      return {
        error: `config.yml routes several hostnames to ${settings.localUrl} (${matching.map((entry) => entry.hostname).join(', ')}). Set the plugin's "hostname" option to choose one.`,
      }
    }
    rule = matching[0]
  }

  const resolvedHostname = (rule?.hostname ?? '').toLowerCase()
  const actual = normalizeService(rule?.service ?? '')
  if (actual !== expected) {
    return { error: `config.yml routes ${resolvedHostname} to "${rule?.service ?? ''}", but this plugin requires ${settings.localUrl}.` }
  }

  const configPath = join(settings.cloudflaredHome, 'config.yml')
  return {
    config: {
      configPath,
      tunnelId,
      credentialsFile: credentialsFile.length > 0 ? credentialsFile : join(settings.cloudflaredHome, `${tunnelId}.json`),
      ingress,
    },
    hostname: resolvedHostname,
  }
}

/**
 * Add one `key: value` pair from an ingress row.
 * @param rule - rule being built.
 * @param content - `key: value` text without the list dash.
 */
function assignIngress(rule: IngressRule, content: string): void {
  const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(content)
  if (match === null) return
  const key = match[1] ?? ''
  const value = match[2] ?? ''
  if (key === 'hostname') rule.hostname = scalar(value)
  else if (key === 'service') rule.service = scalar(value)
}

/**
 * Normalize an ingress service for comparison.
 * @param service - configured service URL.
 * @returns a comparable form without a trailing slash.
 */
function normalizeService(service: string): string {
  return service.trim().replace(/\/+$/, '').toLowerCase()
}

/**
 * Whether a path is a runnable regular file.
 *
 * POSIX needs the execute bit; Windows has no execute bit and reports a
 * non-executable file as executable, so there the regular-file check is the
 * whole test. Treating the two the same makes `cloudflared.exe` invisible on
 * Windows while claiming `.txt` files are runnable.
 * @param path - candidate path.
 * @returns true when the file can be executed.
 */
function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}


/**
 * Locate the `cloudflared` binary: an explicit path wins, then PATH, then the
 * conventional install directories. Nothing is downloaded or installed.
 * @param settings - tunnel settings.
 * @returns the resolved absolute path, or undefined.
 */
export function resolveCloudflaredBinary(settings: TunnelSettings): string | undefined {
  if (settings.cloudflaredPath !== undefined && settings.cloudflaredPath.length > 0) {
    return isExecutable(settings.cloudflaredPath) ? settings.cloudflaredPath : undefined
  }
  const directories = new Set([
    ...pathDirectories(process.platform, process.env.PATH),
    ...binDirectories(process.platform, process.env, homedir()),
  ])
  const extensions = executableExtensions(process.platform, process.env.PATHEXT)
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `cloudflared${extension}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Validate the credentials JSON without exposing its contents.
 * @param file - credentials path from config.
 * @returns the check result.
 */
function checkCredentialsFile(file: string): PrerequisiteCheck {
  const check: PrerequisiteCheck = { id: 'credentials', ok: false, message: '' }
  if (!existsSync(file)) {
    check.message = `Cloudflare Tunnel credentials file is missing (expected <cloudflared-home>/<tunnel-id>.json).`
    check.hint = 'Create or re-authorize the named tunnel; the credentials file must exist before the tunnel can start.'
    return check
  }
  let size = 0
  try {
    const stat = statSync(file)
    if (!stat.isFile()) {
      check.message = 'Cloudflare Tunnel credentials path is not a regular file.'
      check.hint = 'Point the credentials-file entry in config.yml at the tunnel JSON file.'
      return check
    }
    size = stat.size
  } catch {
    check.message = 'Cloudflare Tunnel credentials file could not be read.'
    check.hint = 'Check the file permissions on ~/.cloudflared.'
    return check
  }
  if (size === 0) {
    check.message = 'Cloudflare Tunnel credentials file is empty.'
    check.hint = 'Recreate the named tunnel credentials; the file must contain a tunnel id and secret.'
    return check
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    if (typeof record.TunnelID !== 'string' || record.TunnelID.length === 0 || typeof record.TunnelSecret !== 'string' || record.TunnelSecret.length === 0) {
      check.message = 'Cloudflare Tunnel credentials file is missing its tunnel id or secret.'
      check.hint = 'Recreate the credentials with `cloudflared tunnel create`, then retry.'
      return check
    }
  } catch {
    check.message = 'Cloudflare Tunnel credentials file is not valid JSON.'
    check.hint = 'Recreate the credentials with `cloudflared tunnel create`, then retry.'
    return check
  }
  check.ok = true
  check.message = 'Named tunnel credentials found.'
  return check
}

/**
 * Whether something accepts TCP connections on the local service.
 * @param localUrl - local service root.
 * @param timeoutMs - connection timeout.
 * @returns true when the port accepts a connection.
 */
export function checkLocalPort(localUrl: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const target = new URL(localUrl)
    const port = localPort(localUrl)
    const socket = createConnection({ host: target.hostname, port })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * Run every preflight check without spawning anything and without installing
 * anything. All checks run so the UI can list every missing prerequisite at once.
 * @param settings - fixed settings plus optional path overrides.
 * @returns the complete report.
 */
export async function checkPrerequisites(settings: TunnelSettings): Promise<PrerequisiteReport> {
  const checks: PrerequisiteCheck[] = []
  const binary = resolveCloudflaredBinary(settings)
  if (binary === undefined) {
    checks.push({
      id: 'cloudflared',
      ok: false,
      message: 'cloudflared is not installed or not on PATH.',
      hint: 'Install the Cloudflare Tunnel client (for example `cloudflared`), then restart DSH. Nothing is installed automatically.',
    })
  } else {
    checks.push({ id: 'cloudflared', ok: true, message: 'cloudflared binary found.' })
  }

  const configPath = join(settings.cloudflaredHome, 'config.yml')
  let parsedConfig: TunnelConfig | undefined
  let resolvedHostname = settings.hostname
  if (!existsSync(configPath)) {
    checks.push({
      id: 'config',
      ok: false,
      message: 'Cloudflare Tunnel config not found at ~/.cloudflared/config.yml.',
      hint: `Create the named-tunnel config with a ${settings.hostname} ingress to ${settings.localUrl}.`,
    })
  } else {
    try {
      const parsed = parseTunnelConfig(readFileSync(configPath, 'utf8'), settings)
      if (parsed.config === undefined) {
        checks.push({
          id: 'config',
          ok: false,
          message: parsed.error ?? 'Cloudflare Tunnel config could not be parsed.',
          hint: `The plugin never edits config.yml. Fix the tunnel id and the ${settings.hostname} ingress manually.`,
        })
      } else {
        parsedConfig = parsed.config
        resolvedHostname = parsed.hostname ?? settings.hostname
        checks.push({ id: 'config', ok: true, message: `Tunnel config routes ${resolvedHostname} to the local DSH Web UI.` })
      }
    } catch {
      checks.push({
        id: 'config',
        ok: false,
        message: 'Cloudflare Tunnel config could not be read.',
        hint: `Check the file permissions on ${displayPath(configPath)}`,
      })
    }
  }

  if (parsedConfig !== undefined) {
    checks.push(checkCredentialsFile(parsedConfig.credentialsFile))
  } else {
    checks.push({
      id: 'credentials',
      ok: false,
      message: 'Cloudflare Tunnel credentials were not checked because config.yml is unusable.',
      hint: 'Fix config.yml first; the credentials path is read from it.',
    })
  }

  const listening = await checkLocalPort(settings.localUrl)
  const target = `${new URL(settings.localUrl).hostname}:${localPort(settings.localUrl)}`
  if (listening) {
    checks.push({ id: 'port', ok: true, message: `DSH Web is listening on ${target}.` })
  } else {
    checks.push({
      id: 'port',
      ok: false,
      message: `Nothing is listening on ${target}.`,
      hint: 'Start the DSH Web UI on 127.0.0.1:3080 before turning the tunnel ON.',
    })
  }

  // DSH's /api fence accepts only loopback, its own bind address, or an
  // authority named by --trusted-host. A tunneled browser sends the public
  // hostname as Host, so without --trusted-host the page and the HTML still
  // load while every /api call is refused with 403 - the tunnel looks ON and
  // the chat renders, then fails the moment the UI calls an API.
  const trust = await checkHostTrust(settings.localUrl, resolvedHostname)
  checks.push(trust)

  return {
    ok: checks.every((check) => check.ok),
    checks,
    ...(parsedConfig !== undefined ? { config: parsedConfig } : {}),
    ...(resolvedHostname.length > 0 ? { hostname: resolvedHostname } : {}),
    ...(binary !== undefined ? { binary } : {}),
    checkedAt: Date.now(),
  }
}

/**
 * Ask this DSH instance whether it accepts `hostname` on its /api fence.
 *
 * The probe is decisions a browser cannot fake: DSH answers 403 when the Host
 * is not trusted and 401 when it is trusted but the request carries no
 * credential. Nothing is sent but an empty RPC envelope, and the probe runs
 * against loopback with only the Host header set, exactly like the tunneled
 * request that would otherwise fail later.
 *
 * @param localUrl - loopback DSH Web UI origin.
 * @param hostname - public hostname the tunnel publishes.
 * @returns the trust check result.
 */
export async function checkHostTrust(localUrl: string, hostname: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<PrerequisiteCheck> {
  if (hostname.length === 0) {
    return {
      id: 'trust',
      ok: false,
      message: 'DSH trust could not be verified: no public hostname is configured.',
      hint: 'Set `hostname` in the plugin config or add a matching ingress entry to config.yml.',
    }
  }

  const target = new URL(localUrl)
  let status: number
  try {
    status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: target.hostname,
          port: target.port.length > 0 ? Number(target.port) : 80,
          path: '/api/directoryPicker/list',
          method: 'POST',
          timeout: timeoutMs,
          headers: { host: hostname, 'content-type': 'application/json' },
        },
        (response: IncomingMessage) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        },
      )
      request.on('timeout', () => {
        request.destroy(new Error('probe timed out'))
      })
      request.on('error', reject)
      request.end(JSON.stringify({ rpcId: 'helux-tunnel-trust-probe', payload: {} }))
    })
  } catch {
    return {
      id: 'trust',
      ok: false,
      message: 'DSH trust could not be verified.',
      hint: `Ensure the DSH Web UI answers on ${localUrl}, then restart DSH with --trusted-host ${hostname}.`,
    }
  }

  if (status === 403) {
    return {
      id: 'trust',
      ok: false,
      message: `DSH rejects ${hostname} on its /api routes (HTTP 403).`,
      hint:
        `Restart DSH Web with: dsh web --trusted-host ${hostname} --public-url https://${hostname}\n`
        + 'Without it the page loads but every /api call is refused, so the chat cannot pick a folder or send a message.',
    }
  }

  return {
    id: 'trust',
    ok: true,
    message: `DSH accepts ${hostname} on its /api routes.`,
  }
}
