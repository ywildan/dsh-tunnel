import * as React from 'react'
import { createQrMatrix, type QrMatrix } from './qrcode.js'

/** Element factory: classic React without a JSX runtime import. */
const h = React.createElement

/** Dictionary namespace owned by this plugin. */
const NS = 'heluxTunnel'

/** The id shared by the sidebar entry and the main panel it opens. */
const PANEL_ID = 'helux-tunnel'

/** Local DSH Web root shown while the tunnel is OFF and the Host has not reported one. */
const LOCAL_URL = 'http://127.0.0.1:3080'

/**
 * Local DSH Web root for a snapshot.
 * @param snapshot - latest status snapshot.
 * @returns the configured local URL, falling back to the documented default.
 */
function localUrlOf(snapshot: TunnelSnapshot | null): string {
  return snapshot !== null && typeof snapshot.localUrl === 'string' && snapshot.localUrl.length > 0
    ? snapshot.localUrl
    : LOCAL_URL
}

/**
 * Public URL for a snapshot.
 *
 * The Host derives it from the configured hostname, so the panel never assumes
 * a domain: an unconfigured snapshot falls back to the empty string rather than
 * inventing one.
 * @param snapshot - latest status snapshot.
 * @returns the public URL, or the empty string when unknown.
 */
function publicUrlOf(snapshot: TunnelSnapshot | null): string {
  return snapshot !== null && snapshot.publicUrl.length > 0 ? snapshot.publicUrl : ''
}

/** Same-origin bridge registered by the Host half. */
const API_PREFIX = '/api/helux-tunnel'

type TunnelStatus = 'off' | 'connecting' | 'on' | 'error'
type AccessState = 'unknown' | 'public' | 'access'
type LaunchUrlReason = 'off' | 'token-missing' | 'local-unreachable'

interface PrerequisiteCheck {
  id: string
  ok: boolean
  message: string
  hint?: string
}

interface TunnelSnapshot {
  status: TunnelStatus
  error: string | null
  errorCode: string | null
  startedAt: number | null
  stoppedAt: number | null
  uptimeMs: number
  publicUrl: string
  localUrl?: string
  access: AccessState
  accessCheckedAt: number | null
  accessChecking: boolean
  prereqs: PrerequisiteCheck[]
  prereqsOk: boolean
  logs: string[]
  busy: boolean
  autoStart: false
  remoteAuthorities: boolean | null
  launchUrlAvailable: boolean
  launchUrlPreview: string | null
  launchUrlReason: LaunchUrlReason | null
  /** True only when /status answered a loopback request. */
  launchLocal?: boolean
  checkedAt: number
}

interface TunnelActionResult {
  ok: boolean
  code?: string
  error?: string
  already?: boolean
  snapshot?: TunnelSnapshot
}

interface PanelProps {
  t: (key: string) => string
}

//#region dictionaries
const en: Record<string, string> = {
  panel: 'Helux Tunnel',
  title: 'Helux Tunnel',
  subtitle: 'Cloudflare Tunnel for {host}',
  'state.loading': 'Loading tunnel state…',
  'state.unreachable': 'The tunnel controller is unreachable. The Host half of the plugin did not answer on /api/helux-tunnel.',
  'status.off': 'OFF',
  'status.connecting': 'CONNECTING',
  'status.on': 'ON',
  'status.error': 'ERROR',
  'toggle.label': 'Helux Tunnel power',
  'toggle.on': 'ON',
  'toggle.off': 'OFF',
  'toggle.starting': 'Starting…',
  'toggle.stopping': 'Stopping…',
  'off.message': 'Tunnel is OFF. DSH is only accessible locally at {local}',
  'off.note': 'Nothing is published to the internet while the switch is OFF.',
  'preflight.title': 'Prerequisites',
  'preflight.ok': 'All prerequisites met',
  'preflight.missing': 'Missing prerequisites',
  'check.cloudflared': 'cloudflared binary',
  'check.config': 'Tunnel config',
  'check.credentials': 'Tunnel credentials',
  'check.port': 'Local DSH Web',
  'on.publicUrl': 'Public URL',
  'on.copy': 'Copy URL',
  'on.copied': 'Copied',
  'launch.copy': 'Copy launch URL',
  'launch.copying': 'Copying...',
  'launch.preview': 'Masked preview',
  'launch.reason.off': 'Tunnel is OFF. Turn it ON to copy the launch URL.',
  'launch.reason.remote': 'Launch URL copying is available only from the local DSH page at {local}.',
  'launch.reason.token-missing': 'Token not found - open the URL printed by dsh web in its terminal',
  'launch.reason.local-unreachable': 'DSH Web is not reachable at http://127.0.0.1:3080.',
  'launch.toast': 'Launch URL copied - do not share, it is like a password',
  'launch.copyFailed': 'Could not access the clipboard. Select and copy the URL manually.',
  'qr.button': 'Pair device (QR)',
  'qr.title': 'Scan with the Helux Android app',
  'qr.hide': 'Hide QR',
  'qr.warning': 'This QR contains the launch token - treat it like a password. Do not photograph or share it.',
  'qr.autohide': 'The QR hides itself after 60 seconds.',
  'on.uptime': 'Uptime',
  'on.access': 'Access',
  'access.public_short': 'No Access policy detected',
  'access.access_short': 'Cloudflare Access',
  'access.unknown_short': 'Unverified',
  'access.public_warning': 'Warning: public without Access policy',
  'access.public_note': '{url} answers requests directly: DSH\'s own launch-token check is the only gate in front of this Web UI. Enable Cloudflare Access on {host} to require a login, and never share the launch URL.',
  'access.access_note': 'Cloudflare Access appears to protect this hostname. This plugin does not modify or bypass it.',
  'access.unknown_note': 'Could not verify Cloudflare Access. When ON, {url} is public unless Cloudflare Access is enabled.',
  'access.recheck': 'Recheck',
  'access.checking': 'Checking…',
  'logs.title': 'cloudflared log',
  'logs.hint': 'Last lines',
  'logs.empty': 'No log lines yet.',
  'error.title': 'Tunnel error',
  'error.generic': 'The tunnel request failed.',
  'security.title': 'Security',
  'security.public': 'When ON, {url} is public unless Cloudflare Access is enabled.',
  'security.never': 'This plugin never disables or bypasses Cloudflare Access.',
  autoStart: 'The tunnel never starts automatically. Every DSH restart begins OFF.',
  trustHint: 'DSH may reject the public authority. If {url} loads but stays disconnected, restart DSH Web with --trusted-host {host} (and optionally --public-url {url}).',
}

const zh: Record<string, string> = {
  panel: 'Helux 隧道',
  title: 'Helux 隧道',
  subtitle: '用于 {host} 的 Cloudflare 隧道',
  'state.loading': '正在加载隧道状态…',
  'state.unreachable': '无法连接隧道控制器。插件的 Host 部分未响应 /api/helux-tunnel。',
  'status.off': '关闭',
  'status.connecting': '连接中',
  'status.on': '已开启',
  'status.error': '错误',
  'toggle.label': 'Helux 隧道开关',
  'toggle.on': '开启',
  'toggle.off': '关闭',
  'toggle.starting': '正在启动…',
  'toggle.stopping': '正在停止…',
  'off.message': '隧道已关闭。DSH 仅可通过本地地址 {local} 访问',
  'off.note': '开关关闭时，不会有任何内容发布到互联网。',
  'preflight.title': '前置检查',
  'preflight.ok': '所有前置条件已满足',
  'preflight.missing': '缺少前置条件',
  'check.cloudflared': 'cloudflared 可执行文件',
  'check.config': '隧道配置',
  'check.credentials': '隧道凭据',
  'check.port': '本地 DSH Web',
  'on.publicUrl': '公网地址',
  'on.copy': '复制 URL',
  'on.copied': '已复制',
  'launch.copy': '复制启动链接',
  'launch.copying': '正在复制...',
  'launch.preview': '脱敏预览',
  'launch.reason.off': '隧道已关闭。请先开启隧道,再复制启动链接。',
  'launch.reason.remote': '启动链接只能从本地 DSH 页面复制:{local}。',
  'launch.reason.token-missing': '未找到令牌 - 请在 dsh web 终端中打开其打印的 URL',
  'launch.reason.local-unreachable': '本地 http://127.0.0.1:3080 上的 DSH Web 不可达。',
  'launch.toast': '启动链接已复制 - 请勿分享,它等同于密码',
  'launch.copyFailed': '无法访问剪贴板。请手动选择并复制。',
  'qr.button': '配对设备 (QR)',
  'qr.title': '用 Helux 安卓应用扫描',
  'qr.hide': '隐藏二维码',
  'qr.warning': '此二维码包含启动令牌 - 请像对待密码一样保管,切勿拍照或分享。',
  'qr.autohide': '二维码将在 60 秒后自动隐藏。',
  'on.uptime': '运行时长',
  'on.access': '访问控制',
  'access.public_short': '未检测到 Access 策略',
  'access.access_short': 'Cloudflare Access',
  'access.unknown_short': '未验证',
  'access.public_warning': '警告：没有 Access 策略，当前为公开状态',
  'access.public_note': '{url} 会直接响应请求:该 Web UI 前唯一的门槛是 DSH 自身的启动令牌校验。请在 {host} 上启用 Cloudflare Access 以要求登录,并且绝不要分享启动链接。',
  'access.access_note': 'Cloudflare Access 似乎正在保护该域名。本插件不会修改或绕过它。',
  'access.unknown_note': '无法验证 Cloudflare Access。开启后，若未启用 Cloudflare Access，{url} 即为公开状态。',
  'access.recheck': '重新检查',
  'access.checking': '检查中…',
  'logs.title': 'cloudflared 日志',
  'logs.hint': '最近日志',
  'logs.empty': '暂无日志。',
  'error.title': '隧道错误',
  'error.generic': '隧道请求失败。',
  'security.title': '安全提示',
  'security.public': '开启后，若未启用 Cloudflare Access，{url} 将对公网开放。',
  'security.never': '本插件绝不会禁用或绕过 Cloudflare Access。',
  autoStart: '隧道不会自动启动。每次 DSH 重启后都从关闭状态开始。',
  trustHint: 'DSH 可能拒绝公网 authority。如果 {url} 能打开但一直未连接，请使用 --trusted-host {host}（可选再加 --public-url {url}）重启 DSH Web。',
}
//#endregion

/**
 * Fetch the Host bridge and decode its JSON body.
 * @param path - path below the plugin API prefix.
 * @param method - HTTP method.
 * @returns the decoded body.
 */
async function request(path: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const message = typeof record.error === 'string' ? record.error : `Request failed (HTTP ${response.status})`
    throw new Error(message)
  }
  return body
}

/**
 * Read a snapshot out of an unknown API body.
 * @param body - decoded response.
 * @returns the snapshot, or null when the body is not one.
 */
function asSnapshot(body: unknown): TunnelSnapshot | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  return typeof record.status === 'string' && typeof record.publicUrl === 'string' ? (record as unknown as TunnelSnapshot) : null
}

/**
 * Read an action result out of an unknown API body.
 * @param body - decoded response.
 * @returns the result, or null when the body is not one.
 */
function asActionResult(body: unknown): TunnelActionResult | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (typeof record.ok !== 'boolean') return null
  const result: TunnelActionResult = { ok: record.ok }
  if (typeof record.error === 'string') result.error = record.error
  if (typeof record.code === 'string') result.code = record.code
  const snapshot = asSnapshot(record.snapshot)
  if (snapshot !== null) result.snapshot = snapshot
  return result
}

/**
 * Format a duration as HH:MM:SS.
 * @param milliseconds - duration in milliseconds.
 * @returns zero-padded clock text.
 */
function formatUptime(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * Convert an unknown thrown value to display text.
 * @param cause - thrown value.
 * @returns the message.
 */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Copy text with the async Clipboard API, falling back to a hidden textarea for
 * browsers or contexts where that API is unavailable.
 * @param text - text to copy.
 * @returns true when the browser reported a successful copy.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

/**
 * The Helux Tunnel control panel: a large OFF/ON switch, status, prerequisites,
 * public URL, uptime, Access posture, and the last cloudflared lines.
 * @param props - localized translator supplied by the slot locale.
 * @returns the panel tree.
 */
function HeluxTunnelPanel({ t }: PanelProps): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<TunnelSnapshot | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [launchCopied, setLaunchCopied] = React.useState(false)
  const [launchPending, setLaunchPending] = React.useState(false)
  const [launchError, setLaunchError] = React.useState<string | null>(null)
  const [qr, setQr] = React.useState<{ preview: string; matrix: QrMatrix } | null>(null)
  const [qrPending, setQrPending] = React.useState(false)
  const [unreachable, setUnreachable] = React.useState(false)
  const [now, setNow] = React.useState(Date.now())

  // Text that names the deployment's own hostname is templated, never hard-coded:
  // this panel runs on whatever domain the user configured.
  const hostUrl = publicUrlOf(snapshot)
  const th = (key: string): string => {
    const url = hostUrl.length > 0 ? hostUrl : 'the public URL'
    const host = hostUrl.length > 0 ? hostUrl.replace(/^https?:\/\//, '') : 'the configured hostname'
    const local = localUrlOf(snapshot)
    // Single pass so a substitution can never introduce a second placeholder.
    return t(key).replace(/\{(url|host|local)\}/g, (_match, name: string) => {
      if (name === 'url') return url
      return name === 'host' ? host : local
    })
  }
  const inFlight = React.useRef(false)
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const launchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const qrTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const next = asSnapshot(await request('/status'))
      if (next !== null) {
        setSnapshot(next)
        setUnreachable(false)
      }
    } catch {
      setUnreachable(true)
    } finally {
      inFlight.current = false
    }
  }, [])

  React.useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      if (!active) return
      await refresh()
      if (!active) return
      timer = setTimeout(() => {
        void tick()
      }, 1500)
    }
    void tick()
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [refresh])

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  React.useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    if (launchTimer.current !== null) clearTimeout(launchTimer.current)
    if (qrTimer.current !== null) clearTimeout(qrTimer.current)
  }, [])

  const status: TunnelStatus = snapshot?.status ?? 'off'
  const isOn = status === 'on'
  const isConnecting = status === 'connecting'
  const isError = status === 'error'
  const disabled = pending || isConnecting || snapshot === null
  const access: AccessState = snapshot?.access ?? 'unknown'
  const startedAt = snapshot?.startedAt ?? null
  const uptime = isOn && startedAt !== null ? formatUptime(now - startedAt) : formatUptime(0)
  const message = actionError ?? snapshot?.error ?? null
  const launchAvailable = isOn && (snapshot?.launchUrlAvailable ?? false) && snapshot?.launchLocal !== false
  const launchReason = !isOn
    ? t('launch.reason.off')
    : launchAvailable
      ? null
      : snapshot?.launchLocal === false
        ? th('launch.reason.remote')
        : t(`launch.reason.${snapshot?.launchUrlReason ?? 'token-missing'}`)

  const toggle = async (): Promise<void> => {
    if (snapshot === null || pending || isConnecting) return
    const turningOn = !isOn
    setPending(true)
    setActionError(null)
    try {
      const result = asActionResult(await request(turningOn ? '/start' : '/stop', 'POST'))
      if (result !== null) {
        if (result.snapshot !== undefined) setSnapshot(result.snapshot)
        if (!result.ok) setActionError(result.error ?? t('error.generic'))
      }
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  const recheckAccess = async (): Promise<void> => {
    if (pending || snapshot === null) return
    setPending(true)
    setActionError(null)
    try {
      const next = asSnapshot(await request('/access-check', 'POST'))
      if (next !== null) setSnapshot(next)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setPending(false)
    }
  }

  const copyUrl = async (): Promise<void> => {
    const url = publicUrlOf(snapshot)
    if (!(await writeClipboard(url))) return
    setCopied(true)
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1800)
  }

  /**
   * Ask the Host for DSH's in-memory launch token, copy it immediately, and
   * discard it. The full URL is never stored in React state or anywhere else.
   */
  const copyLaunchUrl = async (): Promise<void> => {
    if (!launchAvailable || launchPending) return
    setLaunchPending(true)
    setLaunchError(null)
    try {
      const body = await request('/launch-url', 'POST')
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      if (typeof record.url !== 'string' || record.url.length === 0) {
        throw new Error(typeof record.error === 'string' ? record.error : t('launch.reason.token-missing'))
      }
      const launchUrl = record.url
      if (!(await writeClipboard(launchUrl))) throw new Error(t('launch.copyFailed'))
      setLaunchCopied(true)
      if (launchTimer.current !== null) clearTimeout(launchTimer.current)
      launchTimer.current = setTimeout(() => setLaunchCopied(false), 6000)
    } catch (cause) {
      setLaunchError(errorText(cause))
    } finally {
      setLaunchPending(false)
    }
  }

  /**
   * Clear the rendered QR and cancel its auto-hide timer. Called on hide, on
   * tunnel state changes, and on unmount, so no launch URL lingers on screen.
   */
  const hideQr = React.useCallback((): void => {
    if (qrTimer.current !== null) clearTimeout(qrTimer.current)
    qrTimer.current = null
    setQr(null)
  }, [])

  /**
   * Fetch the launch URL once, draw it as a QR matrix, and hold only the matrix
   * plus the masked preview. The URL text itself is dropped immediately; the QR
   * hides itself after 60 seconds.
   */
  const showQr = async (): Promise<void> => {
    if (!launchAvailable || qrPending) return
    setQrPending(true)
    setLaunchError(null)
    try {
      const body = await request('/launch-url', 'POST')
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      if (typeof record.url !== 'string' || record.url.length === 0) {
        throw new Error(typeof record.error === 'string' ? record.error : t('launch.reason.token-missing'))
      }
      const matrix = createQrMatrix(record.url)
      const preview = typeof record.preview === 'string' ? record.preview : ''
      setQr({ preview, matrix })
      if (qrTimer.current !== null) clearTimeout(qrTimer.current)
      qrTimer.current = setTimeout(() => {
        qrTimer.current = null
        setQr(null)
      }, 60_000)
    } catch (cause) {
      setLaunchError(errorText(cause))
    } finally {
      setQrPending(false)
    }
  }

  // A closed tunnel, a lost token, a non-loopback page, or a busy action all
  // retire a visible QR immediately.
  React.useEffect(() => {
    if (!launchAvailable) hideQr()
  }, [launchAvailable, hideQr])

  /**
   * Render a QR matrix as a single SVG path: one `<path>` for all dark modules.
   * @param matrix - generated QR matrix.
   * @returns the SVG element.
   */
  const qrSvg = (matrix: QrMatrix): React.ReactElement => {
    const quiet = 4
    const total = matrix.size + quiet * 2
    const segments: string[] = []
    for (let row = 0; row < matrix.size; row += 1) {
      for (let col = 0; col < matrix.size; col += 1) {
        if (matrix.dark(row, col)) segments.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
      }
    }
    return h('svg', {
      className: 'ht-qr-svg',
      viewBox: `0 0 ${total} ${total}`,
      width: 240,
      height: 240,
      role: 'img',
      'aria-label': t('qr.title'),
      shapeRendering: 'crispEdges',
    },
      h('rect', { x: 0, y: 0, width: total, height: total, fill: '#ffffff' }),
      h('path', { d: segments.join(''), fill: '#000000' }))
  }

  const accessNote = access === 'public'
    ? h('div', { className: 'ht-banner ht-banner-danger', role: 'status' },
        h('strong', null, t('access.public_warning')),
        h('span', null, th('access.public_note')))
    : access === 'access'
      ? h('div', { className: 'ht-banner ht-banner-ok', role: 'status' },
          h('strong', null, t('access.access_short')),
          h('span', null, t('access.access_note')))
      : h('div', { className: 'ht-banner ht-banner-warn', role: 'status' },
          h('strong', null, t('access.unknown_short')),
          h('span', null, th('access.unknown_note')),
          h('button', {
            type: 'button',
            className: 'ht-button ht-button-small',
            onClick: () => { void recheckAccess() },
            disabled: pending || (snapshot?.accessChecking ?? false),
          }, snapshot?.accessChecking ? t('access.checking') : t('access.recheck')))

  const header = h('header', { className: 'ht-head' },
    h('div', { className: 'ht-head-text' },
      h('h1', { className: 'ht-title' }, t('title')),
      h('p', { className: 'ht-subtitle' }, th('subtitle'))),
    h('span', { className: `ht-status ht-status-${status}` },
      isConnecting
        ? h('span', { className: 'ht-spinner', 'aria-hidden': true })
        : h('span', { className: 'ht-dot', 'aria-hidden': true }),
      h('span', null, t(`status.${status}`))))

  if (snapshot === null) {
    return h('div', { className: 'ht-root' },
      h('style', null, CSS),
      header,
      h('div', { className: 'ht-state' }, unreachable ? t('state.unreachable') : t('state.loading')))
  }

  const power = h('section', { className: 'ht-power' },
    h('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': isOn,
      'aria-label': t('toggle.label'),
      className: `ht-switch${isOn ? ' ht-switch-on' : ''}${isConnecting ? ' ht-switch-connecting' : ''}${isError ? ' ht-switch-error' : ''}`,
      onClick: () => { void toggle() },
      disabled,
    },
      h('span', { className: 'ht-track', 'aria-hidden': true }, h('span', { className: 'ht-thumb' })),
      h('span', { className: 'ht-switch-text' }, pending
        ? t(isOn ? 'toggle.stopping' : 'toggle.starting')
        : t(isOn ? 'toggle.on' : 'toggle.off'))),
    h('div', { className: 'ht-power-side' },
      h('div', { className: 'ht-kicker' }, t('on.publicUrl')),
      h('code', { className: 'ht-local' }, isOn ? publicUrlOf(snapshot) : localUrlOf(snapshot)),
      h('p', { className: 'ht-power-note' }, isOn ? t('off.note') : th('off.message'))))

  const errorBanner = message !== null
    ? h('div', { className: 'ht-banner ht-banner-error', role: 'alert' },
        h('strong', null, t('error.title')),
        h('span', null, message))
    : null

  const preflight = h('section', { className: 'ht-card' },
    h('div', { className: 'ht-card-head' },
      h('h2', { className: 'ht-card-title' }, t('preflight.title')),
      h('span', { className: `ht-chip ${snapshot.prereqsOk ? 'ht-chip-ok' : 'ht-chip-warn'}` },
        snapshot.prereqsOk ? t('preflight.ok') : t('preflight.missing'))),
    h('ul', { className: 'ht-checks' }, snapshot.prereqs.map((check) => h('li', {
      key: check.id,
      className: `ht-check ${check.ok ? 'ht-check-ok' : 'ht-check-bad'}`,
    },
      h('span', { className: 'ht-check-icon', 'aria-hidden': true }, check.ok ? '✓' : '✕'),
      h('div', { className: 'ht-check-body' },
        h('div', { className: 'ht-check-name' }, t(`check.${check.id}`)),
        h('div', { className: 'ht-check-message' }, check.message),
        !check.ok && check.hint !== undefined
          ? h('div', { className: 'ht-check-hint' }, check.hint)
          : null)))))

  const logs = h('div', { className: 'ht-logs-block' },
    h('div', { className: 'ht-card-head ht-logs-head' },
      h('h2', { className: 'ht-card-title' }, t('logs.title')),
      h('span', { className: 'ht-kicker' }, t('logs.hint'))),
    h('pre', { className: 'ht-logs', tabIndex: 0 },
      snapshot.logs.length > 0 ? snapshot.logs.slice(-12).join('\n') : t('logs.empty')))

  const launchButton = h('button', {
    type: 'button',
    className: 'ht-button',
    onClick: () => { void copyLaunchUrl() },
    disabled: !launchAvailable || launchPending,
    title: launchReason ?? t('launch.copy'),
  }, launchPending ? t('launch.copying') : launchCopied ? t('on.copied') : t('launch.copy'))

  const qrButton = h('button', {
    type: 'button',
    className: 'ht-button',
    onClick: () => { if (qr !== null) hideQr(); else void showQr() },
    disabled: !launchAvailable || qrPending,
    title: launchReason ?? t('qr.button'),
    'aria-expanded': qr !== null,
  }, qrPending ? t('launch.copying') : qr !== null ? t('qr.hide') : t('qr.button'))

  const qrPanel = qr !== null
    ? h('div', { className: 'ht-qr' },
        h('div', { className: 'ht-qr-canvas' }, qrSvg(qr.matrix)),
        h('div', { className: 'ht-qr-side' },
          h('div', { className: 'ht-qr-title' }, t('qr.title')),
          h('p', { className: 'ht-qr-warning', role: 'alert' }, t('qr.warning')),
          h('p', { className: 'ht-note' }, t('qr.autohide')),
          qr.preview.length > 0
            ? h('p', { className: 'ht-note' },
                `${t('launch.preview')}: `,
                h('code', { className: 'ht-launch-preview' }, qr.preview))
            : null,
          h('button', {
            type: 'button',
            className: 'ht-button ht-button-small',
            onClick: () => hideQr(),
          }, t('qr.hide'))))
    : null

  const running = isOn
    ? h('section', { className: 'ht-card ht-card-on' },
        h('div', { className: 'ht-url-row' },
          h('div', { className: 'ht-url-block' },
            h('div', { className: 'ht-kicker' }, t('on.publicUrl')),
            h('a', {
              className: 'ht-url',
              href: publicUrlOf(snapshot),
              target: '_blank',
              rel: 'noreferrer noopener',
            }, publicUrlOf(snapshot))),
          h('div', { className: 'ht-url-actions' },
            h('button', { type: 'button', className: 'ht-button', onClick: () => { void copyUrl() } },
              copied ? t('on.copied') : t('on.copy')),
            launchButton,
            qrButton)),
        qrPanel,
        h('div', { className: 'ht-launch-row' },
          launchReason !== null
            ? h('span', { className: 'ht-note' }, launchReason)
            : snapshot.launchUrlPreview !== null
              ? h('span', { className: 'ht-note' },
                  `${t('launch.preview')}: `,
                  h('code', { className: 'ht-launch-preview' }, snapshot.launchUrlPreview))
              : null),
        h('div', { className: 'ht-meta-grid' },
          h('div', null,
            h('div', { className: 'ht-kicker' }, t('on.uptime')),
            h('div', { className: 'ht-meta-value' }, uptime)),
          h('div', null,
            h('div', { className: 'ht-kicker' }, t('on.access')),
            h('div', { className: 'ht-meta-value' }, t(`access.${access}_short`)))),
        accessNote,
        snapshot.remoteAuthorities === false ? h('p', { className: 'ht-note' }, th('trustHint')) : null,
        logs)
    : isError
      ? h('section', { className: 'ht-card' }, logs)
      : h('section', { className: 'ht-card ht-off-card' },
          h('p', { className: 'ht-off-message' }, th('off.message')),
          h('p', { className: 'ht-note' }, t('off.note')),
          h('div', { className: 'ht-launch-row' },
            h('button', {
              type: 'button',
              className: 'ht-button',
              disabled: true,
              title: t('launch.reason.off'),
            }, t('launch.copy')),
            h('button', {
              type: 'button',
              className: 'ht-button',
              disabled: true,
              title: t('qr.button'),
            }, t('qr.button')),
            h('span', { className: 'ht-note' }, t('launch.reason.off'))))

  const toast = launchCopied
    ? h('div', { className: 'ht-toast', role: 'status' }, t('launch.toast'))
    : launchError !== null
      ? h('div', { className: 'ht-toast ht-toast-error', role: 'alert' }, launchError)
      : null

  const footer = h('footer', { className: 'ht-foot' },
    h('p', null,
      h('strong', null, `${t('security.title')}: `),
      th('security.public')),
    h('p', null, t('security.never')),
    h('p', { className: 'ht-muted' }, t('autoStart')))

  return h('div', { className: 'ht-root' },
    h('style', null, CSS),
    header,
    power,
    errorBanner,
    preflight,
    running,
    footer,
    toast)
}

/** Sidebar rail icon for the Helux Tunnel entry. */
function HeluxTunnelIcon({ size, active }: { size?: number; active?: boolean }): React.ReactElement {
  const edge = typeof size === 'number' ? size : 20
  const accent = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
  return h('svg', {
    viewBox: '0 0 24 24',
    width: edge,
    height: edge,
    'aria-hidden': true,
    style: { display: 'block' },
  },
    h('path', {
      d: 'M3.5 20v-8.5a8.5 8.5 0 0 1 17 0V20',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
    }),
    h('path', {
      d: 'M8.5 20v-7.2a3.5 3.5 0 0 1 7 0V20',
      fill: 'none',
      stroke: accent,
      strokeWidth: 1.7,
      strokeLinecap: 'round',
    }),
    h('path', { d: 'M2 20h20', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', opacity: 0.65 }),
    h('circle', { cx: 12, cy: 17.4, r: 1.15, fill: accent }),
  )
}

const CSS = `
.ht-root{display:flex;flex-direction:column;gap:16px;padding:24px 28px 40px;overflow-y:auto;height:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.5}
.ht-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ht-head-text{min-width:0}
.ht-title{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ht-subtitle{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:60ch}
.ht-status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:5px 11px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.ht-status-off{color:var(--dsw-alias-state-idle-primary)}
.ht-status-connecting{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ht-status-on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ht-status-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ht-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
.ht-spinner{width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;display:inline-block;animation:ht-spin .8s linear infinite}
@keyframes ht-spin{to{transform:rotate(360deg)}}
.ht-power{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:20px 22px}
.ht-switch{appearance:none;display:inline-flex;align-items:center;gap:14px;border:none;background:transparent;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.ht-switch:disabled{opacity:.6;cursor:default}
.ht-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:4px;border-radius:999px}
.ht-track{position:relative;width:104px;height:52px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-sizing:border-box;transition:background .18s ease,border-color .18s ease;flex:0 0 auto}
.ht-thumb{position:absolute;top:4px;left:4px;width:42px;height:42px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .18s ease,background .18s ease}
.ht-switch-on .ht-track{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ht-switch-on .ht-thumb{transform:translateX(52px);background:var(--dsw-alias-bg-base)}
.ht-switch-connecting .ht-track{background:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ht-switch-error .ht-track{border-color:var(--dsw-alias-state-error-primary)}
.ht-switch-text{font-size:20px;font-weight:700;letter-spacing:.08em;color:var(--dsw-alias-label-primary);min-width:52px}
.ht-switch-on .ht-switch-text{color:var(--dsw-alias-state-success-primary)}
.ht-power-side{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 260px}
.ht-power-note{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:56ch}
.ht-kicker{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.ht-local{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:var(--dsw-alias-label-primary)}
.ht-banner{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:11px 14px;font-size:12px;background:var(--dsw-alias-bg-layer-1)}
.ht-banner strong{font-weight:600;white-space:normal}
.ht-banner span{color:var(--dsw-alias-label-secondary);flex:1 1 260px}
.ht-banner-error{border-color:var(--dsw-alias-state-error-primary)}
.ht-banner-error strong{color:var(--dsw-alias-state-error-primary)}
.ht-banner-danger{border-color:var(--dsw-alias-state-error-primary)}
.ht-banner-danger strong{color:var(--dsw-alias-state-error-primary)}
.ht-banner-warn{border-color:var(--dsw-alias-state-warn-primary)}
.ht-banner-warn strong{color:var(--dsw-alias-state-warn-primary)}
.ht-banner-ok{border-color:var(--dsw-alias-state-success-primary)}
.ht-banner-ok strong{color:var(--dsw-alias-state-success-primary)}
.ht-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px;display:flex;flex-direction:column;gap:12px}
.ht-card-on{gap:14px}
.ht-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ht-card-title{margin:0;font-size:13px;font-weight:600}
.ht-chip{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.ht-chip-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ht-chip-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.ht-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}
.ht-check{display:flex;gap:10px;align-items:flex-start}
.ht-check-icon{width:18px;height:18px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-size:11px;font-weight:700;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.ht-check-ok .ht-check-icon{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.ht-check-bad .ht-check-icon{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.ht-check-body{min-width:0}
.ht-check-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ht-check-message{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ht-check-hint{font-size:11px;color:var(--dsw-alias-state-warn-primary);margin-top:2px}
.ht-url-row{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ht-url-block{min-width:0}
.ht-url-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ht-launch-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:30px}
.ht-launch-preview{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px;overflow-wrap:anywhere}
.ht-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;max-width:min(520px,90vw);padding:11px 16px;border-radius:10px;border:1px solid var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:0 8px 28px rgba(0,0,0,.35)}
.ht-toast-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.ht-qr{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:14px}
.ht-qr-canvas{flex:0 0 auto;line-height:0;border-radius:8px;background:#ffffff;padding:6px}
.ht-qr-svg{display:block;width:240px;height:240px}
.ht-qr-side{display:flex;flex-direction:column;gap:8px;min-width:0;flex:1 1 220px}
.ht-qr-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ht-qr-warning{margin:0;font-size:11px;font-weight:600;color:var(--dsw-alias-state-warn-primary);max-width:60ch}
.ht-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;font-weight:600;color:var(--dsw-alias-brand-primary);text-decoration:none;overflow-wrap:anywhere}
.ht-url:hover{text-decoration:underline}
.ht-button{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 14px;font-size:12px;font-weight:500;cursor:pointer}
.ht-button:hover{background:var(--dsw-alias-bg-base)}
.ht-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.ht-button:disabled{opacity:.55;cursor:default}
.ht-button-small{padding:4px 10px;font-size:11px}
.ht-meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.ht-meta-value{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.ht-note{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);max-width:80ch}
.ht-off-card{gap:6px}
.ht-off-message{margin:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.ht-logs-head{margin-top:2px}
.ht-logs{margin:0;max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.ht-logs:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ht-foot{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}
.ht-foot p{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);max-width:90ch}
.ht-muted{opacity:.85}
.ht-state{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary)}
`

/** Client services this module reads. */
interface ClientContext {
  locale: {
    register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => () => void
    bind: (namespace: string) => (key: string) => string
  }
  slots: {
    inject: (name: string, callback: () => unknown) => void
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  effect: (callback: () => void | (() => void), label?: string) => void
}

/** Services required by the Client half. */
export const inject = ['slots', 'locale']

/**
 * Register the Helux Tunnel panel and its sidebar entry. The panel starts OFF
 * because the Host state starts OFF; this half never calls the start endpoint.
 * @param ctx - Client slot and locale services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'helux-tunnel: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, HeluxTunnelPanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    locale: NS,
    label: () => t('panel'),
  }, HeluxTunnelIcon))
}
