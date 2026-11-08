import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

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

/** Result of one preflight check. */
export interface PrerequisiteCheck {
  id: 'cloudflared' | 'config' | 'credentials' | 'port'
  ok: boolean
  message: string
  hint?: string
}

/** Complete preflight report, including the parsed config on success. */
export interface PrerequisiteReport {
  ok: boolean
  checks: PrerequisiteCheck[]
  config?: TunnelConfig
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
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
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
  if (unquoted === '~' || unquoted.startsWith('~/')) return join(homedir(), unquoted.slice(1))
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
export function parseTunnelConfig(text: string, settings: TunnelSettings): { config?: TunnelConfig; error?: string } {
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

  const hostname = settings.hostname.toLowerCase()
  const rule = ingress.find((entry) => (entry.hostname ?? '').toLowerCase() === hostname)
  if (rule === undefined) {
    return { error: `config.yml has no ingress entry for ${settings.hostname}.` }
  }
  const expected = normalizeService(settings.localUrl)
  const actual = normalizeService(rule.service ?? '')
  if (actual !== expected) {
    return { error: `config.yml routes ${settings.hostname} to "${rule.service ?? ''}", but this plugin requires ${settings.localUrl}.` }
  }

  const configPath = join(settings.cloudflaredHome, 'config.yml')
  return {
    config: {
      configPath,
      tunnelId,
      credentialsFile: credentialsFile.length > 0 ? credentialsFile : join(settings.cloudflaredHome, `${tunnelId}.json`),
      ingress,
    },
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
 * Whether a path is an executable regular file.
 * @param path - candidate path.
 * @returns true when the file can be executed.
 */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return statSync(path).isFile()
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
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const directories = new Set((process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0))
  if (process.platform !== 'win32') {
    for (const fallback of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', join(homedir(), '.local', 'bin')]) {
      directories.add(fallback)
    }
  }
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
    check.message = 'Cloudflare Tunnel credentials file is missing (expected ~/.cloudflared/<tunnel-id>.json).'
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
  if (!existsSync(configPath)) {
    checks.push({
      id: 'config',
      ok: false,
      message: 'Cloudflare Tunnel config not found at ~/.cloudflared/config.yml.',
      hint: 'Create the named-tunnel config with a helux.web.id ingress to http://127.0.0.1:3080.',
    })
  } else {
    try {
      const parsed = parseTunnelConfig(readFileSync(configPath, 'utf8'), settings)
      if (parsed.config === undefined) {
        checks.push({
          id: 'config',
          ok: false,
          message: parsed.error ?? 'Cloudflare Tunnel config could not be parsed.',
          hint: 'The plugin never edits config.yml. Fix the tunnel id and the helux.web.id ingress manually.',
        })
      } else {
        parsedConfig = parsed.config
        checks.push({ id: 'config', ok: true, message: 'Tunnel config routes helux.web.id to the local DSH Web UI.' })
      }
    } catch {
      checks.push({
        id: 'config',
        ok: false,
        message: 'Cloudflare Tunnel config could not be read.',
        hint: 'Check the file permissions on ~/.cloudflared/config.yml.',
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

  return {
    ok: checks.every((check) => check.ok),
    checks,
    ...(parsedConfig !== undefined ? { config: parsedConfig } : {}),
    ...(binary !== undefined ? { binary } : {}),
    checkedAt: Date.now(),
  }
}