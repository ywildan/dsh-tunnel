import { homedir } from 'node:os';
import { join } from 'node:path';
/**
 * The plugin id shared by the Loader row, the sidebar entry, and the main panel.
 * @remarks The Client registers both slots under this single id, so the sidebar
 * button always addresses this plugin's panel.
 */
export const PLUGIN_ID = 'helux-tunnel';
/** Public hostname of the user's pre-created named tunnel. Fixed by requirement. */
export const PUBLIC_HOSTNAME = 'helux.web.id';
/** Public URL announced while the tunnel is ON. */
export const PUBLIC_URL = `https://${PUBLIC_HOSTNAME}`;
/** Local service the tunnel ingress must point at. Fixed by requirement. */
export const LOCAL_URL = 'http://127.0.0.1:3080';
/** Port the local service listens on, derived from {@link LOCAL_URL}. */
export const LOCAL_PORT = 3080;
/** Same-origin bridge the Client panel calls. */
export const API_PREFIX = '/api/helux-tunnel';
/** Directory holding `config.yml` and `<tunnel-id>.json`. */
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
