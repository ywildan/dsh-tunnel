import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * The plugin id shared by the Loader row, the sidebar entry, and the main panel.
 * @remarks The Client registers both slots under this single id, so the sidebar
 * button always addresses this plugin's panel.
 */
export const PLUGIN_ID = 'helux-tunnel';
/**
 * Hostname used when the plugin row sets none.
 *
 * This is a default, not a requirement: every deployment configures its own
 * hostname in the plugin config, and this value only keeps an unconfigured
 * install behaving exactly as it did before the hostname became configurable.
 */
export const DEFAULT_HOSTNAME = 'helux.web.id';
/** Local service used when the plugin row sets none. */
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:3080';
/** Port the local service listens on, derived from {@link DEFAULT_LOCAL_URL}. */
export const LOCAL_PORT = 3080;
/** Same-origin bridge the Client panel calls. */
export const API_PREFIX = '/api/helux-tunnel';
/**
 * Directory holding `config.yml` and `<tunnel-id>.json`.
 *
 * `homedir()` resolves to the Windows profile directory on Windows, so the same
 * default works on every platform without a special case.
 */
export const DEFAULT_CLOUDFLARED_HOME = join(homedir(), '.cloudflared');
/** DSH home used for the plugin's log and state files. */
export function resolveDshHome() {
    const fromEnv = process.env.DSH_HOME;
    return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}
/** Retained log lines exposed to the UI. */
export const CLIENT_LOG_LINES = 40;
/** Hard cap on retained log lines in memory. */
export const MEMORY_LOG_LINES = 400;
