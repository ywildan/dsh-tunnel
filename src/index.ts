import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_PREFIX, PLUGIN_ID } from './host/constants.js'
import { Config, resolveConfig, toTunnelSettings, type HeluxTunnelConfig } from './host/config.js'
import { createTunnelRouteHandler } from './host/api.js'
import {
  HeluxTunnelManager,
  type TunnelActionResult,
  type TunnelSnapshot,
} from './host/manager.js'

/** Minimal ContentBlock shape used for tool rendering. */
interface TextBlock {
  type: 'text'
  text: string
}

/** Minimal ToolDefinition shape accepted by `ctx.tools.register`. */
interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => TextBlock[]
  }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** The Host services and lifecycle this plugin needs. */
interface HostContext {
  tools: {
    register: (definition: ToolDefinitionLike) => () => void
  }
  webServer: {
    register: (route: {
      kind: 'prefix'
      path: string
      handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
    }) => () => void
  }
  effect: (callback: () => void | (() => void), label?: string) => void
  /** Optional-service lookup for the Connection trust posture and launch token. */
  get?: (name: string) => unknown
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
  }
}

/**
 * The subset of DSH's Connection service this plugin reads. `authenticatedUrl`
 * is the exact method `dsh-web-app` uses to print the launch URL at startup; it
 * reads the per-process token that DSH keeps only in memory.
 */
interface ConnectionLike {
  allowsRemoteAuthorities?: boolean
  authenticatedUrl?: (baseUrl: string) => string
}

/** Cordis plugin name. */
export const name = PLUGIN_ID

/** Services required for the tools and the browser bridge. */
export const inject = ['tools', 'webServer']

/** Config schema; re-exported so the Loader validates the row and the settings UI can render it. */
export { Config }

/** Output schema shared by tunnel_start and tunnel_stop. */
const ACTION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'string' },
    publicUrl: { type: 'string' },
    access: { type: 'string' },
    code: { type: 'string' },
    error: { type: 'string' },
    startedAt: { type: 'number' },
    uptimeMs: { type: 'number' },
  },
  required: ['ok', 'status', 'publicUrl', 'access'],
}

/** Output schema for tunnel_status. */
const STATUS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string' },
    publicUrl: { type: 'string' },
    access: { type: 'string' },
    error: { type: 'string' },
    errorCode: { type: 'string' },
    startedAt: { type: 'number' },
    uptimeMs: { type: 'number' },
    prerequisites: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['id', 'ok', 'message'],
      },
    },
    logTail: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'publicUrl', 'access', 'prerequisites', 'logTail'],
}

/** No-argument parameter schema. */
const NO_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

/**
 * Reduce a start/stop result to the fields the model and the UI need.
 * @param result - manager outcome.
 * @returns JSON-safe tool value.
 */
function actionPayload(result: TunnelActionResult): Record<string, unknown> {
  const snapshot = result.snapshot
  return {
    ok: result.ok,
    status: snapshot.status,
    publicUrl: snapshot.publicUrl,
    access: snapshot.access,
    ...(result.code !== undefined ? { code: result.code } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(snapshot.startedAt !== null ? { startedAt: snapshot.startedAt } : {}),
    ...(snapshot.uptimeMs > 0 ? { uptimeMs: snapshot.uptimeMs } : {}),
  }
}

/**
 * Project a snapshot for tunnel_status without the full log ring.
 * @param snapshot - live snapshot.
 * @returns JSON-safe tool value.
 */
function statusPayload(snapshot: TunnelSnapshot): Record<string, unknown> {
  return {
    status: snapshot.status,
    publicUrl: snapshot.publicUrl,
    access: snapshot.access,
    ...(snapshot.error !== null ? { error: snapshot.error } : {}),
    ...(snapshot.errorCode !== null ? { errorCode: snapshot.errorCode } : {}),
    ...(snapshot.startedAt !== null ? { startedAt: snapshot.startedAt } : {}),
    uptimeMs: snapshot.uptimeMs,
    prerequisites: snapshot.prereqs.map((check) => ({ id: check.id, ok: check.ok, message: check.message })),
    logTail: snapshot.logs.slice(-8),
  }
}

/**
 * Build the resolver that asks DSH for a tokenized launch URL.
 *
 * Kept separate from `apply` so the important invariant is directly testable:
 * DSH is only ever given an origin that actually has a hostname. In the default
 * auto-detect mode the hostname does not exist until the first preflight, so an
 * eager read here would produce "https://", which is not a URL.
 *
 * @param ctx - Host context exposing the Connection service.
 * @param currentOrigin - Returns the manager's origin at call time.
 * @returns a resolver suitable for the manager's `resolveLaunchUrl` option.
 */
export function createLaunchUrlResolver(
  ctx: HostContext,
  currentOrigin: () => string,
): () => string | undefined {
  return () => {
    const connection = ctx.get?.('connection') as ConnectionLike | undefined
    if (typeof connection?.authenticatedUrl !== 'function') return undefined
    // Read the origin now, not at construction: an auto-detected hostname only
    // exists after the first preflight has parsed config.yml.
    const baseUrl = currentOrigin()
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
    try {
      return connection.authenticatedUrl(baseUrl)
    } catch {
      return undefined
    }
  }
}

/**
 * Register the tunnel tools, the same-origin Client bridge, and the manager
 * lifecycle. This never starts the tunnel: `initialize()` only resets the
 * persisted state to OFF and runs the preflight checks.
 * @param ctx - Host context with the tool registry and web server.
 */
export function apply(ctx: HostContext, config?: Partial<HeluxTunnelConfig>): void {
  // Validation happens here, at activation: a bad hostname must fail the plugin
  // row loudly instead of starting a tunnel that serves the wrong name.
  const settings = resolveConfig(config)
  // `settings.hostname` is empty when the row leaves it unset, which is the
  // advertised default: the manager then adopts the hostname from config.yml.
  // The origin therefore cannot be derived here, and reading it off `manager`
  // would make the constructor argument self-referential - hence the holder.
  // Explicitly typed so the constructor argument is not self-referential for
  // type inference; the value is only read long after construction.
  let managerRef: HeluxTunnelManager | undefined
  const manager = new HeluxTunnelManager({
    settings: toTunnelSettings(settings),
    remoteAuthorities: (ctx.get?.('connection') as ConnectionLike | undefined)?.allowsRemoteAuthorities === true,
    // Resolved lazily, and only ever with an origin that has a hostname. The
    // returned URL is used immediately and discarded; the manager never caches,
    // logs, or persists the token.
    resolveLaunchUrl: createLaunchUrlResolver(ctx, () => managerRef?.publicUrl ?? ''),
  })
  managerRef = manager

  ctx.effect(() => {
    void manager.initialize().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`helux-tunnel: initialization failed: ${message}`)
    })
    return () => {
      void manager.dispose()
    }
  }, 'helux-tunnel: manager lifecycle')

  // Tool descriptions are registered once, before the first preflight resolves
  // an auto-detected hostname. Naming a concrete URL here would be wrong for
  // every auto-detect deployment, so describe the destination instead.
  const destination = settings.hostname.length === 0
    ? 'the configured public hostname'
    : `https://${settings.hostname}`

  ctx.effect(() => {
    const disposeStart = ctx.tools.register({
      name: 'tunnel_start',
      description: `Turn the Helux Cloudflare Tunnel ON so ${destination} serves the local DSH Web UI at ${settings.localUrl} through the user's existing named tunnel. Call this ONLY when the user explicitly asks in this chat to start or turn on the tunnel. Never call it on your own initiative, on startup, after a restart, or merely to inspect state. The sidebar toggle is the primary control. The call fails visibly and starts nothing when cloudflared, the named-tunnel credentials, config.yml, or the local port is unavailable.`,
      parameters: NO_PARAMETERS,
      output: {
        schema: ACTION_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => actionPayload(await manager.start()),
    })

    const disposeStop = ctx.tools.register({
      name: 'tunnel_stop',
      description: `Turn the Helux Cloudflare Tunnel OFF and stop the cloudflared child process, making ${destination} unreachable. Safe to call when the tunnel is already OFF. Only call when the user explicitly asks to stop or turn off the tunnel, or when shutting down this control at the user's request.`,
      parameters: NO_PARAMETERS,
      output: {
        schema: ACTION_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => actionPayload(await manager.stop()),
    })

    const disposeStatus = ctx.tools.register({
      name: 'tunnel_status',
      description: 'Report the Helux Cloudflare Tunnel state without changing it: OFF, CONNECTING, ON, or ERROR, plus the public URL, Cloudflare Access posture, prerequisite checks, and the last log lines.',
      parameters: NO_PARAMETERS,
      output: {
        schema: STATUS_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => statusPayload(await manager.snapshot()),
    })

    return () => {
      disposeStart()
      disposeStop()
      disposeStatus()
    }
  }, 'helux-tunnel: tools')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: createTunnelRouteHandler(manager),
    }),
    'helux-tunnel: client bridge',
  )
}