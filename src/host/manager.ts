import { spawn, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  checkLocalPort,
  checkPrerequisites,
  type PrerequisiteCheck,
  type PrerequisiteReport,
  type TunnelConfig,
  type TunnelSettings,
} from './prerequisites.js'
import { terminationStrategy } from './platform.js'
import { redactSecrets } from './redact.js'
import {
  CLIENT_LOG_LINES,
  DEFAULT_CLOUDFLARED_HOME,
  DEFAULT_HOSTNAME,
  DEFAULT_LOCAL_URL,
  MEMORY_LOG_LINES,
  resolveDshHome,
} from './constants.js'

/** The four states the panel renders. */
export type TunnelStatus = 'off' | 'connecting' | 'on' | 'error'

/** Whether the public hostname is protected by Cloudflare Access. */
export type AccessState = 'unknown' | 'public' | 'access'

/** Why the launch URL cannot be copied right now. */
export type LaunchUrlReason = 'off' | 'token-missing' | 'local-unreachable'

/** Result of a launch-URL request; the full URL is never retained server-side. */
export interface LaunchUrlResult {
  ok: boolean
  /** Present only in the direct response to an explicit copy request. */
  url?: string
  /** Masked URL safe to render; only the token's last four characters. */
  preview?: string
  code?: 'TUNNEL_OFF' | 'TOKEN_MISSING' | 'LOCAL_UNREACHABLE'
  error?: string
}

/** JSON-safe status payload shared by the HTTP bridge, the tools, and the UI. */
export interface TunnelSnapshot {
  status: TunnelStatus
  error: string | null
  errorCode: string | null
  startedAt: number | null
  stoppedAt: number | null
  uptimeMs: number
  publicUrl: string
  /** Local DSH Web root the tunnel points at, as configured. */
  localUrl: string
  access: AccessState
  accessCheckedAt: number | null
  accessChecking: boolean
  prereqs: PrerequisiteCheck[]
  prereqsOk: boolean
  logs: string[]
  busy: boolean
  /** Always false: the tunnel never auto-starts, by design. */
  autoStart: false
  /** Whether DSH accepts non-loopback authorities, when the Host exposes it. */
  remoteAuthorities: boolean | null
  /** Whether "Copy launch URL" can run: ON, token resolved, local port reachable. */
  launchUrlAvailable: boolean
  /** Masked launch URL (`?token=••••abcd`), or null when unavailable. */
  launchUrlPreview: string | null
  /** Why the launch URL is unavailable; null when it is available. */
  launchUrlReason: LaunchUrlReason | null
  checkedAt: number
}

/** Result of a start/stop request, carrying the state that followed it. */
export interface TunnelActionResult {
  ok: boolean
  code?: string
  error?: string
  already?: boolean
  snapshot: TunnelSnapshot
}

/** Cloudflare Access probe result. */
export interface AccessProbeResult {
  status: number
  location: string
  /**
   * First characters of the response body. DSH answers its own unauthenticated
   * index request with a 401 and a fixed sentence; that proves the request
   * reached DSH, so no Access gate intercepts it.
   */
  body?: string
}

/** Test seam for the public-URL probe. */
export type AccessProbe = (url: string, signal: AbortSignal) => Promise<AccessProbeResult>

/** Construction options; every setting resolves to the fixed product values. */
export interface TunnelManagerOptions {
  settings?: Partial<TunnelSettings>
  logger?: (line: string) => void
  probe?: AccessProbe
  remoteAuthorities?: boolean
  /**
   * Reads DSH's per-process launch token from the in-process Connection service.
   * Returns the tokenized URL, or undefined when this DSH build cannot expose it.
   * The manager never persists or logs the returned value.
   */
  resolveLaunchUrl?: () => string | undefined
}

const READY_PATTERN = /registered tunnel connection|connection [0-9a-f-]+ registered/i
const FATAL_PATTERN = /(?:failed to (?:authenticate|login|run|start) tunnel|invalid tunnel secret|tunnel credentials[^\n]*(?:not found|does not exist)|unauthorized)/i
const READINESS_TIMEOUT_MS = 20_000
const STOP_SIGNAL_TIMEOUT_MS = 5_000
const ACCESS_REDIRECT_MARKER = 'cloudflareaccess.com'
/** The exact body DSH returns for an unauthenticated index request. */
const DSH_UNAUTHENTICATED_MARKER = 'authentication required'
const PROBE_BODY_LIMIT = 512

/**
 * Decide whether Cloudflare Access protects the public hostname.
 *
 * A 401/403 alone is ambiguous: DSH itself answers an unauthenticated request
 * with 401, so treating every 401 as "Access is on" reports protection that may
 * not exist — dangerous next to a button that copies the launch token. Only an
 * Access login redirect (or a refusal that is not DSH's own fence) counts.
 * @param result - probe output.
 * @returns the Access posture.
 */
export function classifyAccess(result: AccessProbeResult): AccessState {
  const location = result.location.toLowerCase()
  if (location.includes(ACCESS_REDIRECT_MARKER)) return 'access'
  const body = (result.body ?? '').toLowerCase()
  if (body.includes(DSH_UNAUTHENTICATED_MARKER)) return 'public'
  if (result.status === 401 || result.status === 403) return 'access'
  if (result.status >= 200 && result.status < 400) return 'public'
  return 'unknown'
}

/**
 * Probe the public URL without following redirects so a Cloudflare Access
 * login redirect stays visible.
 * @param url - public URL.
 * @param signal - abort signal owned by the caller.
 * @returns status, location header, and a short body excerpt.
 */
async function defaultProbe(url: string, signal: AbortSignal): Promise<AccessProbeResult> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      'cache-control': 'no-cache',
      'user-agent': 'dsh-helux-tunnel/2.0',
    },
  })
  const body = await response.text().catch(() => '')
  return {
    status: response.status,
    location: response.headers.get('location') ?? '',
    body: body.slice(0, PROBE_BODY_LIMIT),
  }
}

/**
 * Own the `cloudflared tunnel run` child process and every piece of state the
 * panel shows.
 *
 * Invariants:
 * - Construction and {@link initialize} never spawn anything; `status` starts OFF.
 * - `start()` is the only path to a child process.
 * - Every state change that matters is written to the state file and the log
 *   file with an ISO timestamp.
 * - Disposal kills the child process.
 */
export class HeluxTunnelManager {
  private readonly settings: TunnelSettings
  /** Hostname adopted from config.yml when the plugin row configures none. */
  private derivedHostname: string | null = null
  private readonly logger: ((line: string) => void) | undefined
  private readonly probe: AccessProbe
  private readonly remoteAuthorities: boolean | undefined
  private readonly resolveLaunchUrl: (() => string | undefined) | undefined

  private status: TunnelStatus = 'off'
  private error: string | null = null
  private errorCode: string | null = null
  private startedAt: number | null = null
  private stoppedAt: number | null = null
  private access: AccessState = 'unknown'
  private accessCheckedAt: number | null = null
  private accessChecking = false

  private child: ChildProcess | null = null
  private stopping = false
  private stopRequested = false
  private stopPromise: Promise<TunnelActionResult> | null = null
  private readinessTimer: NodeJS.Timeout | null = null
  private exitDeferred: { promise: Promise<void>; resolve: () => void } | null = null
  private readonly streamBuffers = new Map<string, string>()

  private readonly logLines: string[] = []
  private prereqReport: PrerequisiteReport | null = null
  private readonly logPath: string
  private readonly statePath: string
  private initialized = false
  private disposed = false

  /**
   * @param options - optional path overrides, logger, and probe seam.
   */
  constructor(options: TunnelManagerOptions = {}) {
    this.settings = {
      cloudflaredHome: options.settings?.cloudflaredHome ?? DEFAULT_CLOUDFLARED_HOME,
      dshHome: options.settings?.dshHome ?? resolveDshHome(),
      hostname: options.settings?.hostname ?? DEFAULT_HOSTNAME,
      localUrl: options.settings?.localUrl ?? DEFAULT_LOCAL_URL,
      ...(options.settings?.cloudflaredPath !== undefined ? { cloudflaredPath: options.settings.cloudflaredPath } : {}),
    }
    this.logger = options.logger
    this.probe = options.probe ?? defaultProbe
    this.remoteAuthorities = options.remoteAuthorities
    this.resolveLaunchUrl = options.resolveLaunchUrl
    this.logPath = join(this.settings.dshHome, 'logs', 'helux-tunnel.log')
    this.statePath = join(this.settings.dshHome, 'data', 'helux-tunnel', 'state.json')
  }

  /**
   * Prepare the plugin directories, force the persisted state to OFF, and run
   * the first preflight. Never starts the tunnel.
   * @returns the first preflight report.
   */
  async initialize(): Promise<PrerequisiteReport> {
    if (this.initialized) return this.prereqReport ?? checkPrerequisites(this.settings)
    this.initialized = true
    await mkdir(dirname(this.logPath), { recursive: true }).catch(() => undefined)
    await mkdir(dirname(this.statePath), { recursive: true }).catch(() => undefined)
    this.appendLog('[helux-tunnel] plugin loaded: tunnel is OFF (auto-start is disabled; every DSH start begins OFF)')
    await this.persistState()
    const report = await this.refreshPrerequisites()
    this.appendLog(`[helux-tunnel] preflight ${report.ok ? 'passed' : 'failed'}: ${report.checks.map((check) => `${check.id}=${check.ok ? 'ok' : 'missing'}`).join(' ')}`)
    return report
  }

  /**
   * Hostname the tunnel publishes.
   *
   * The plugin row wins when it sets one; otherwise the value is taken from the
   * tunnel's own `config.yml` ingress, so a user who already configured
   * cloudflared needs no plugin configuration at all.
   * @returns the effective hostname, or null before the first preflight.
   */
  get hostname(): string | null {
    if (this.settings.hostname.length > 0) return this.settings.hostname
    return this.derivedHostname
  }

  /**
   * Public origin for the effective hostname.
   * @returns the origin, or the empty string while the hostname is unknown.
   */
  get publicUrl(): string {
    const hostname = this.hostname
    return hostname === null ? '' : `https://${hostname}`
  }

  /**
   * Re-run every preflight check. Never spawns or installs anything.
   * @returns the fresh report.
   */
  async refreshPrerequisites(): Promise<PrerequisiteReport> {
    const report = await checkPrerequisites(this.settings)
    this.prereqReport = report
    if (report.hostname !== undefined && report.hostname.length > 0) {
      this.derivedHostname = report.hostname
    }
    return report
  }

  /**
   * Build the JSON-safe payload the UI and the tools read.
   * @returns the current snapshot; refreshes stale preflight data when idle.
   */
  async snapshot(): Promise<TunnelSnapshot> {
    const stale = this.prereqReport === null || Date.now() - this.prereqReport.checkedAt > 8_000
    if (stale && !this.stopping && !this.disposed && (this.status === 'off' || this.status === 'error')) {
      await this.refreshPrerequisites().catch(() => undefined)
    }
    const report = this.prereqReport
    const launch = this.launchState()
    return {
      status: this.status,
      error: this.error,
      errorCode: this.errorCode,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      uptimeMs: this.status === 'on' && this.startedAt !== null ? Date.now() - this.startedAt : 0,
      publicUrl: this.publicUrl,
      localUrl: this.settings.localUrl,
      access: this.access,
      accessCheckedAt: this.accessCheckedAt,
      accessChecking: this.accessChecking,
      prereqs: report?.checks ?? [],
      prereqsOk: report?.ok ?? false,
      logs: this.logLines.slice(-CLIENT_LOG_LINES),
      busy: this.stopping || this.status === 'connecting',
      autoStart: false,
      remoteAuthorities: this.remoteAuthorities ?? null,
      launchUrlAvailable: launch.available,
      launchUrlPreview: launch.preview,
      launchUrlReason: launch.reason,
      checkedAt: Date.now(),
    }
  }

  /**
   * Turn the tunnel ON. Refuses — visibly — when any prerequisite fails, so a
   * broken setup never starts silently.
   * @returns the outcome plus the resulting snapshot.
   */
  async start(): Promise<TunnelActionResult> {
    if (this.disposed) {
      return { ok: false, code: 'DISPOSED', error: 'The Helux Tunnel plugin is shutting down.', snapshot: await this.snapshot() }
    }
    if (this.status === 'on' || this.status === 'connecting') {
      return { ok: true, already: true, snapshot: await this.snapshot() }
    }
    if (this.stopping) {
      return { ok: false, code: 'BUSY', error: 'The tunnel is still stopping. Try again in a moment.', snapshot: await this.snapshot() }
    }

    const report = await this.refreshPrerequisites()
    if (!report.ok || report.binary === undefined || report.config === undefined) {
      const failed = report.checks.filter((check) => !check.ok)
      const message = failed.length > 0
        ? failed.map((check) => check.message).join(' ')
        : 'The tunnel prerequisites are incomplete.'
      this.status = 'error'
      this.error = message
      this.errorCode = 'PREREQUISITES'
      this.startedAt = null
      this.appendLog(`[helux-tunnel] START blocked: ${failed.map((check) => check.id).join(', ') || 'unknown prerequisite'}`)
      await this.persistState()
      return { ok: false, code: 'PREREQUISITES', error: message, snapshot: await this.snapshot() }
    }

    const config: TunnelConfig = report.config
    const binary = report.binary
    const args = ['tunnel', '--config', config.configPath, '--no-autoupdate', 'run', config.tunnelId]
    this.appendLog(`[helux-tunnel] START requested for ${this.publicUrl || '(hostname not configured)'}`)

    try {
      const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        windowsHide: true,
      })
      this.child = child
      this.status = 'connecting'
      this.error = null
      this.errorCode = null
      this.startedAt = Date.now()
      this.stoppedAt = null
      this.access = 'unknown'
      this.accessCheckedAt = null
      this.stopping = false
      this.stopRequested = false
      this.exitDeferred = createDeferred()

      const stdout = child.stdout
      const stderr = child.stderr
      if (stdout !== null) {
        stdout.setEncoding('utf8')
        stdout.on('data', (chunk: string) => this.consume('stdout', chunk))
      }
      if (stderr !== null) {
        stderr.setEncoding('utf8')
        stderr.on('data', (chunk: string) => this.consume('stderr', chunk))
      }

      child.once('error', (cause: Error) => {
        this.child = null
        this.clearReadiness()
        this.status = 'error'
        this.errorCode = 'SPAWN_FAILED'
        this.error = `cloudflared could not be started: ${redactSecrets(cause.message)}`
        this.startedAt = null
        this.appendLog(`[helux-tunnel] ERROR SPAWN_FAILED: ${cause.message}`)
        this.exitDeferred?.resolve()
        void this.persistState()
      })

      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => this.handleExit(code, signal))

      this.readinessTimer = setTimeout(() => {
        if (this.status !== 'connecting' || this.child === null) return
        this.setError('cloudflared did not register a tunnel connection within 20 seconds. Check the tunnel credentials and network.', 'NO_CONNECTION')
        this.terminateAfterError()
      }, READINESS_TIMEOUT_MS)
      this.readinessTimer.unref?.()

      this.appendLog(`[helux-tunnel] cloudflared started (pid ${child.pid ?? 'unknown'})`)
      void this.persistState()
      return { ok: true, snapshot: await this.snapshot() }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.status = 'error'
      this.errorCode = 'SPAWN_FAILED'
      this.error = `cloudflared could not be started: ${redactSecrets(message)}`
      this.startedAt = null
      this.appendLog(`[helux-tunnel] ERROR SPAWN_FAILED: ${message}`)
      void this.persistState()
      return { ok: false, code: 'SPAWN_FAILED', error: this.error, snapshot: await this.snapshot() }
    }
  }

  /**
   * Turn the tunnel OFF and reap the child process. Idempotent; concurrent
   * callers share one stop operation.
   * @returns the outcome plus the resulting snapshot.
   */
  async stop(): Promise<TunnelActionResult> {
    if (this.stopPromise !== null) return this.stopPromise
    this.stopRequested = true
    const child = this.child
    if (child === null) {
      this.finalizeOff('already off')
      return { ok: true, snapshot: await this.snapshot() }
    }

    const pid = child.pid ?? 'unknown'
    this.appendLog(`[helux-tunnel] STOP requested (pid ${pid})`)
    this.stopping = true
    this.clearReadiness()

    this.stopPromise = (async (): Promise<TunnelActionResult> => {
      terminateTree(child, false)
      const escalation = setTimeout(() => {
        if (this.child === child) {
          this.appendLog(`[helux-tunnel] cloudflared did not exit after ${process.platform === 'win32' ? 'termination request' : 'SIGTERM'}; forcing it`)
          terminateTree(child, true)
        }
      }, STOP_SIGNAL_TIMEOUT_MS)
      escalation.unref?.()

      await Promise.race([this.exitDeferred?.promise ?? Promise.resolve(), delay(STOP_SIGNAL_TIMEOUT_MS + 2_000)])
      clearTimeout(escalation)

      if (this.child === child) {
        terminateTree(child, true)
        await Promise.race([this.exitDeferred?.promise ?? Promise.resolve(), delay(2_000)])
      }
      if (this.child === child) {
        this.child = null
        this.finalizeOff('cloudflared did not report exit; state forced OFF')
      }
      this.stopping = false
      this.stopRequested = false
      this.stopPromise = null
      return { ok: true, snapshot: await this.snapshot() }
    })()

    return this.stopPromise
  }

  /**
   * Probe the public URL for a Cloudflare Access redirect. Only meaningful
   * while the tunnel is ON.
   * @returns nothing; the result lands in the snapshot.
   */
  async probeAccess(): Promise<void> {
    if (this.status !== 'on' || this.accessChecking) return
    // Nothing to probe until a hostname is known; leave Access as 'unknown'
    // rather than fetching an empty URL.
    if (this.publicUrl.length === 0) return
    this.accessChecking = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    timer.unref?.()
    try {
      const result = await this.probe(this.publicUrl, controller.signal)
      this.access = classifyAccess(result)
      this.accessCheckedAt = Date.now()
      this.appendLog(`[helux-tunnel] ACCESS_CHECK ${this.access} (HTTP ${result.status})`)
    } catch {
      this.access = 'unknown'
      this.accessCheckedAt = Date.now()
      this.appendLog('[helux-tunnel] ACCESS_CHECK unknown (public URL probe failed)')
    } finally {
      clearTimeout(timer)
      this.accessChecking = false
    }
  }

  /**
   * Whether the launch URL can be copied, with a masked preview. The full
   * tokenized URL is resolved and discarded in this method; it is never stored.
   * @returns availability, the masked preview, and a reason when unavailable.
   */
  private launchState(): { available: boolean; preview: string | null; reason: LaunchUrlReason | null } {
    if (this.status !== 'on') return { available: false, preview: null, reason: 'off' }
    if (this.prereqReport?.checks.find((check) => check.id === 'port')?.ok !== true) {
      return { available: false, preview: null, reason: 'local-unreachable' }
    }
    const url = this.resolveLaunchUrlSafely()
    if (url === null) return { available: false, preview: null, reason: 'token-missing' }
    const preview = maskedLaunchPreview(url)
    return preview === null
      ? { available: false, preview: null, reason: 'token-missing' }
      : { available: true, preview, reason: null }
  }

  /**
   * Return the full launch URL for an explicit, local copy request. The URL is
   * not cached: it is read from DSH's in-memory token, validated, and returned
   * in this response only. Callers must not persist or log it.
   * @returns the URL and mask on success, or a stable reason when unavailable.
   */
  async launchUrl(): Promise<LaunchUrlResult> {
    if (this.status !== 'on') {
      return { ok: false, code: 'TUNNEL_OFF', error: 'The tunnel is OFF. Turn it ON before copying the launch URL.' }
    }
    if (!(await checkLocalPort(this.settings.localUrl))) {
      return { ok: false, code: 'LOCAL_UNREACHABLE', error: `DSH Web is not reachable at ${this.settings.localUrl}.` }
    }
    const url = this.resolveLaunchUrlSafely()
    const preview = url === null ? null : maskedLaunchPreview(url)
    if (url === null || preview === null) {
      return { ok: false, code: 'TOKEN_MISSING', error: 'Token not found - open the URL printed by dsh web in its terminal' }
    }
    return { ok: true, url, preview }
  }

  /**
   * Read and validate DSH's launch URL. Only the fixed public HTTPS origin and
   * a non-empty `token` query are accepted.
   * @returns the URL, or null when unavailable.
   */
  private resolveLaunchUrlSafely(): string | null {
    if (this.resolveLaunchUrl === undefined) return null
    try {
      const candidate = this.resolveLaunchUrl()
      if (typeof candidate !== 'string' || candidate.length === 0) return null
      const url = new URL(candidate)
      if (url.protocol !== 'https:' || url.hostname !== this.hostname) return null
      const token = url.searchParams.get('token')
      if (token === null || token.length === 0) return null
      return url.href
    } catch {
      return null
    }
  }

  /**
   * Kill the child process and release timers. Called from the plugin's effect
   * cleanup on unload and on DSH shutdown.
   * @returns nothing.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearReadiness()
    await this.stop().catch(() => undefined)
  }

  /**
   * Split incoming chunks into complete lines and forward them.
   * @param stream - logical stream name.
   * @param chunk - decoded text.
   */
  private consume(stream: 'stdout' | 'stderr', chunk: string): void {
    const previous = this.streamBuffers.get(stream) ?? ''
    const combined = previous + chunk
    const rows = combined.split(/\r?\n/)
    this.streamBuffers.set(stream, rows.pop() ?? '')
    for (const row of rows) this.handleLine(stream, row)
  }

  /**
   * Inspect one complete cloudflared line for readiness or a fatal error.
   * @param stream - stream the line arrived on.
   * @param line - raw line.
   */
  private handleLine(stream: 'stdout' | 'stderr', line: string): void {
    if (line.trim().length === 0) return
    this.appendLog(`[cloudflared:${stream}] ${line}`)
    if (this.status !== 'connecting') return
    if (READY_PATTERN.test(line)) {
      this.markOn()
      return
    }
    if (FATAL_PATTERN.test(line)) {
      this.setError('cloudflared reported an authentication or tunnel error. Check the named-tunnel credentials and config.', 'CLOUDFLARED')
      this.terminateAfterError()
    }
  }

  /**
   * Transition CONNECTING → ON and start the Access probe.
   */
  private markOn(): void {
    if (this.status !== 'connecting') return
    this.clearReadiness()
    this.status = 'on'
    this.startedAt ??= Date.now()
    this.error = null
    this.errorCode = null
    this.appendLog(`[helux-tunnel] TUNNEL_ON ${this.publicUrl || '(hostname not configured)'}`)
    void this.persistState()
    void this.probeAccess()
  }

  /**
   * Record an error that the panel must show. Keeps the child for
   * {@link terminateAfterError} to reap.
   * @param message - user-facing explanation.
   * @param code - stable error code.
   */
  private setError(message: string, code: string): void {
    this.status = 'error'
    this.error = redactSecrets(message)
    this.errorCode = code
    this.startedAt = null
    this.clearReadiness()
    this.appendLog(`[helux-tunnel] ERROR ${code}: ${message}`)
    void this.persistState()
  }

  /**
   * Stop a child process that failed after it started. The error state stays
   * visible; the exit handler will not clear it.
   */
  private terminateAfterError(): void {
    const child = this.child
    if (child === null) return
    terminateTree(child, false)
    const escalation = setTimeout(() => {
      if (this.child === child) terminateTree(child, true)
    }, 4_000)
    escalation.unref?.()
  }

  /**
   * Process the child's exit exactly once.
   * @param code - exit code.
   * @param signal - terminating signal.
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopping = this.stopping || this.stopRequested
    this.child = null
    this.clearReadiness()
    this.streamBuffers.clear()
    this.exitDeferred?.resolve()
    this.exitDeferred = null
    this.stopping = false
    const detail = signal !== null ? `signal ${signal}` : `code ${code ?? 'unknown'}`

    if (wasStopping) {
      this.finalizeOff(`cloudflared exited (${detail})`)
    } else if (this.status === 'error') {
      this.appendLog(`[helux-tunnel] cloudflared exited after error (${detail})`)
      void this.persistState()
    } else {
      this.status = 'error'
      this.errorCode = 'EXITED'
      this.error = `cloudflared exited unexpectedly (${detail}). The public URL is not reachable.`
      this.startedAt = null
      this.appendLog(`[helux-tunnel] ERROR EXITED: cloudflared stopped unexpectedly (${detail})`)
      void this.persistState()
    }
    this.stopRequested = false
  }

  /**
   * Force the OFF state, clearing any error, and log the transition.
   * @param reason - what produced the OFF state.
   */
  private finalizeOff(reason: string): void {
    const alreadyOff = this.status === 'off'
    this.status = 'off'
    this.error = null
    this.errorCode = null
    this.startedAt = null
    this.access = 'unknown'
    this.accessCheckedAt = null
    this.stopping = false
    if (!alreadyOff) {
      this.stoppedAt = Date.now()
      this.appendLog(`[helux-tunnel] TUNNEL_OFF (${reason})`)
    }
    void this.persistState()
  }

  /** Cancel the registration-readiness timer. */
  private clearReadiness(): void {
    if (this.readinessTimer === null) return
    clearTimeout(this.readinessTimer)
    this.readinessTimer = null
  }

  /**
   * Append a redacted, timestamped line to the in-memory ring, the log file,
   * and the optional logger. Never writes credential material.
   * @param text - line to record.
   */
  private appendLog(text: string): void {
    const line = `[${new Date().toISOString()}] ${redactSecrets(text)}`
    this.logLines.push(line)
    if (this.logLines.length > MEMORY_LOG_LINES) this.logLines.splice(0, this.logLines.length - MEMORY_LOG_LINES)
    try {
      this.logger?.(line)
    } catch {
      /* a logger must never break the tunnel */
    }
    void appendFile(this.logPath, `${line}\n`).catch(() => undefined)
  }

  /**
   * Persist state. `enabled` mirrors the live status, but every load forces it
   * back to false; the note records that policy for anyone reading the file.
   * @returns a promise that settles once the file is written.
   */
  private async persistState(): Promise<void> {
    const payload = {
      enabled: this.status === 'on',
      status: this.status,
      updatedAt: new Date().toISOString(),
      publicUrl: this.publicUrl,
      note: 'Auto-start is disabled. Every DSH start forces this state to disabled/off; a previous ON is never resumed.',
    }
    await writeFile(this.statePath, `${JSON.stringify(payload, null, 2)}\n`).catch(() => undefined)
  }
}

/**
 * Render a masked launch URL. Only the token's last four characters survive;
 * the full token is never returned to the UI or written to disk.
 * @param url - tokenized launch URL.
 * @returns masked URL, or null when the URL carries no token.
 */
function maskedLaunchPreview(url: string): string | null {
  try {
    const parsed = new URL(url)
    const token = parsed.searchParams.get('token')
    if (token === null || token.length === 0) return null
    // Echo the URL's own origin so a misconfigured hostname is visible in the
    // preview instead of being masked by a hard-coded one.
    return `${parsed.origin}/?token=••••${token.slice(-4)}`
  } catch {
    return null
  }
}

/**
 * Create a promise plus its resolver.
 * @returns the deferred pair.
 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}


/**
 * Send a termination signal to the child in a way each platform understands.
 *
 * POSIX has SIGTERM, which lets cloudflared close its connections cleanly.
 * Windows has no signals: Node maps every `kill()` to TerminateProcess, so the
 * graceful path does not exist and `SIGKILL` is equivalent. The distinction is
 * kept because the ordering still matters on POSIX and the log line should be
 * honest about what happened.
 * @param child - process to signal.
 * @param signal - requested signal.
 */
function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // The process already exited; every caller tolerates that.
  }
}

/**
 * Recursively terminate a child and its descendants.
 *
 * On Windows `spawn` starts the real cloudflared process directly, but any
 * wrapper (a shim, a `cmd /c`) leaves a grandchild holding the tunnel open. A
 * plain `kill` would report success while the tunnel stayed reachable, so the
 * tree is terminated explicitly.
 * @param child - process to terminate.
 * @param escalate - true for the forced pass.
 */
function terminateTree(child: ChildProcess, escalate: boolean): void {
  const pid = child.pid
  const strategy = terminationStrategy(process.platform)
  const mode = escalate ? strategy.forced : strategy.graceful
  if (mode === 'taskkill' && pid !== undefined) {
    try {
      // /T terminates the tree, /F forces it.
      const args = escalate ? ['/pid', String(pid), '/T', '/F'] : ['/pid', String(pid), '/T']
      spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).once('error', () => undefined)
      return
    } catch {
      // Fall through to the plain signal.
    }
  }
  signalChild(child, escalate ? 'SIGKILL' : 'SIGTERM')
}

/**
 * Wait for an interval.
 * @param milliseconds - delay length.
 * @returns a promise that resolves after the delay.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}