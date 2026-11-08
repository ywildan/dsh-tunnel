import { API_PREFIX, PLUGIN_ID } from './host/constants.js';
import { Config, resolveConfig, toTunnelSettings } from './host/config.js';
import { createTunnelRouteHandler } from './host/api.js';
import { HeluxTunnelManager, } from './host/manager.js';
/** Cordis plugin name. */
export const name = PLUGIN_ID;
/** Services required for the tools and the browser bridge. */
export const inject = ['tools', 'webServer'];
/** Config schema; re-exported so the Loader validates the row and the settings UI can render it. */
export { Config };
/** Output schema shared by tunnel_start and tunnel_stop. */
const ACTION_OUTPUT_SCHEMA = {
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
};
/** Output schema for tunnel_status. */
const STATUS_OUTPUT_SCHEMA = {
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
};
/** No-argument parameter schema. */
const NO_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    properties: {},
};
/**
 * Reduce a start/stop result to the fields the model and the UI need.
 * @param result - manager outcome.
 * @returns JSON-safe tool value.
 */
function actionPayload(result) {
    const snapshot = result.snapshot;
    return {
        ok: result.ok,
        status: snapshot.status,
        publicUrl: snapshot.publicUrl,
        access: snapshot.access,
        ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(snapshot.startedAt !== null ? { startedAt: snapshot.startedAt } : {}),
        ...(snapshot.uptimeMs > 0 ? { uptimeMs: snapshot.uptimeMs } : {}),
    };
}
/**
 * Project a snapshot for tunnel_status without the full log ring.
 * @param snapshot - live snapshot.
 * @returns JSON-safe tool value.
 */
function statusPayload(snapshot) {
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
    };
}
/**
 * Register the tunnel tools, the same-origin Client bridge, and the manager
 * lifecycle. This never starts the tunnel: `initialize()` only resets the
 * persisted state to OFF and runs the preflight checks.
 * @param ctx - Host context with the tool registry and web server.
 */
export function apply(ctx, config) {
    // Validation happens here, at activation: a bad hostname must fail the plugin
    // row loudly instead of starting a tunnel that serves the wrong name.
    const settings = resolveConfig(config);
    // Derived before construction: the launch-URL resolver below closes over it,
    // and reading it off `manager` would make the constructor argument
    // self-referential.
    const publicUrl = `https://${settings.hostname}`;
    const manager = new HeluxTunnelManager({
        settings: toTunnelSettings(settings),
        remoteAuthorities: ctx.get?.('connection')?.allowsRemoteAuthorities === true,
        // Resolve lazily: the Connection service may load after this plugin, and a
        // reload replaces it. The returned URL is used immediately and discarded;
        // the manager never caches, logs, or persists the token.
        resolveLaunchUrl: () => {
            const connection = ctx.get?.('connection');
            if (typeof connection?.authenticatedUrl !== 'function')
                return undefined;
            try {
                return connection.authenticatedUrl(publicUrl);
            }
            catch {
                return undefined;
            }
        },
    });
    ctx.effect(() => {
        void manager.initialize().catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger?.warn?.(`helux-tunnel: initialization failed: ${message}`);
        });
        return () => {
            void manager.dispose();
        };
    }, 'helux-tunnel: manager lifecycle');
    ctx.effect(() => {
        const disposeStart = ctx.tools.register({
            name: 'tunnel_start',
            description: `Turn the Helux Cloudflare Tunnel ON so ${publicUrl} serves the local DSH Web UI at ${settings.localUrl} through the user's existing named tunnel. Call this ONLY when the user explicitly asks in this chat to start or turn on the tunnel. Never call it on your own initiative, on startup, after a restart, or merely to inspect state. The sidebar toggle is the primary control. The call fails visibly and starts nothing when cloudflared, the named-tunnel credentials, config.yml, or the local port is unavailable.`,
            parameters: NO_PARAMETERS,
            output: {
                schema: ACTION_OUTPUT_SCHEMA,
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
            execute: async () => actionPayload(await manager.start()),
        });
        const disposeStop = ctx.tools.register({
            name: 'tunnel_stop',
            description: `Turn the Helux Cloudflare Tunnel OFF and stop the cloudflared child process, making ${publicUrl} unreachable. Safe to call when the tunnel is already OFF. Only call when the user explicitly asks to stop or turn off the tunnel, or when shutting down this control at the user's request.`,
            parameters: NO_PARAMETERS,
            output: {
                schema: ACTION_OUTPUT_SCHEMA,
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
            execute: async () => actionPayload(await manager.stop()),
        });
        const disposeStatus = ctx.tools.register({
            name: 'tunnel_status',
            description: 'Report the Helux Cloudflare Tunnel state without changing it: OFF, CONNECTING, ON, or ERROR, plus the public URL, Cloudflare Access posture, prerequisite checks, and the last log lines.',
            parameters: NO_PARAMETERS,
            output: {
                schema: STATUS_OUTPUT_SCHEMA,
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
            execute: async () => statusPayload(await manager.snapshot()),
        });
        return () => {
            disposeStart();
            disposeStop();
            disposeStatus();
        };
    }, 'helux-tunnel: tools');
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createTunnelRouteHandler(manager),
    }), 'helux-tunnel: client bridge');
}
