import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { DEFAULT_CLOUDFLARED_HOME, DEFAULT_LOCAL_URL, resolveDshHome } from './constants.js';
/**
 * Public hostname, validated as a bare DNS name.
 *
 * Deliberately strict: the value is compared against `config.yml` ingress rows
 * and used to build the launch URL, so a scheme, path, port, or wildcard here
 * would silently produce a URL that DSH rejects. Users configure a hostname,
 * never a URL.
 * @param value - candidate hostname.
 * @returns the lowercased hostname.
 */
function normalizeHostname(value) {
    const hostname = value.trim().toLowerCase().replace(/\.$/, '');
    if (hostname.length === 0)
        throw new Error('hostname must not be empty');
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(hostname)) {
        throw new Error(`hostname must be a bare domain such as "dsh.example.com", not a URL: ${value}`);
    }
    if (hostname.includes('/') || hostname.includes(':') || hostname.includes('?')) {
        throw new Error(`hostname must not contain a path, port, or query: ${value}`);
    }
    if (hostname.includes('*')) {
        throw new Error(`hostname must be one exact name, not a wildcard: ${value}`);
    }
    const labels = hostname.split('.');
    if (labels.length < 2)
        throw new Error(`hostname needs at least one dot, for example "dsh.example.com": ${value}`);
    for (const label of labels) {
        if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
            throw new Error(`hostname label "${label}" is not a valid DNS label`);
        }
    }
    return hostname;
}
/**
 * Local service URL, validated as loopback HTTP(S).
 *
 * The tunnel publishes exactly one local service. Pointing it at a public
 * address would make the plugin a proxy for something it does not own, so only
 * loopback is accepted.
 * @param value - candidate URL.
 * @returns the normalized URL without a trailing slash.
 */
function normalizeLocalUrl(value) {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`localUrl must use http or https: ${value}`);
    }
    const host = url.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (!loopback)
        throw new Error(`localUrl must point at this machine (127.0.0.1 or localhost): ${value}`);
    if (url.pathname !== '/' && url.pathname !== '') {
        throw new Error(`localUrl must not include a path: ${value}`);
    }
    return `${url.protocol}//${url.host}`;
}
/**
 * Plugin configuration shown in the DSH plugin settings and written into the
 * Loader row. Every field is optional: with no configuration the plugin behaves
 * exactly as it did when the hostname was hard-coded.
 */
export const Config = z.object({
    hostname: z
        .string()
        .default('')
        .description('Public hostname your Cloudflare Tunnel publishes, without scheme or path (for example "dsh.example.com"). Leave empty to use the hostname already configured in the tunnel config.yml.'),
    localUrl: z
        .string()
        .default(DEFAULT_LOCAL_URL)
        .description('Local DSH Web UI the tunnel points at. Must be loopback.'),
    cloudflaredPath: z
        .string()
        .description('Absolute path to the cloudflared binary. Leave empty to search PATH.')
        .default(''),
    cloudflaredHome: z
        .string()
        .description('Directory holding config.yml and the tunnel credentials JSON. Leave empty for ~/.cloudflared.')
        .default(''),
    accessCheck: z
        .boolean()
        .default(true)
        .description('Probe the public hostname to report whether Cloudflare Access is protecting it.'),
});
/**
 * Turn a user-supplied row config into validated settings.
 *
 * Validation happens at activation so a typo fails loudly in the plugin row
 * instead of producing a tunnel that starts and then never serves the hostname.
 * @param config - partial row config from the Loader.
 * @returns the normalized configuration.
 */
export function resolveConfig(config = {}) {
    // Empty means "adopt whatever config.yml already publishes", which is the
    // path most users take: they configured cloudflared, not this plugin.
    const rawHostname = config.hostname !== undefined ? config.hostname.trim() : '';
    const rawLocalUrl = config.localUrl !== undefined && config.localUrl.length > 0 ? config.localUrl : DEFAULT_LOCAL_URL;
    const cloudflaredHome = config.cloudflaredHome !== undefined && config.cloudflaredHome.length > 0
        ? expandHome(config.cloudflaredHome.trim())
        : DEFAULT_CLOUDFLARED_HOME;
    const cloudflaredPath = config.cloudflaredPath !== undefined ? expandHome(config.cloudflaredPath.trim()) : '';
    return {
        hostname: rawHostname.length > 0 ? normalizeHostname(rawHostname) : '',
        localUrl: normalizeLocalUrl(rawLocalUrl),
        cloudflaredPath,
        cloudflaredHome,
        accessCheck: config.accessCheck !== false,
    };
}
/**
 * Project the plugin configuration onto the manager's settings.
 * @param config - normalized configuration.
 * @returns settings for the manager and the preflight checks.
 */
export function toTunnelSettings(config) {
    return {
        cloudflaredHome: config.cloudflaredHome,
        dshHome: resolveDshHome(),
        hostname: config.hostname,
        localUrl: config.localUrl,
        ...(config.cloudflaredPath.length > 0 ? { cloudflaredPath: config.cloudflaredPath } : {}),
    };
}
/**
 * Expand a leading `~` so a Windows or POSIX path from config resolves.
 * @param path - possibly abbreviated path.
 * @returns the absolute path.
 */
export function expandHome(path) {
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || path.startsWith('~\\'))
        return join(homedir(), path.slice(2));
    return path;
}
