import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_PREFIX } from './constants.js'
import type { HeluxTunnelManager } from './manager.js'

/** Handler shape accepted by `ctx.webServer.register`. */
export type TunnelRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Headers any reverse proxy or the Cloudflare edge adds to a remote request. */
const FORWARDING_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-ipcountry']

/**
 * Whether a request came from the local DSH page rather than through the
 * tunnel. Control endpoints are local-only: once a tunnel is public, a stranger
 * must not be able to start or stop this machine's tunnel.
 * @param request - incoming request.
 * @returns true when the authority is loopback and no proxy headers exist.
 */
export function isLocalRequest(request: IncomingMessage): boolean {
  if (FORWARDING_HEADERS.some((header) => request.headers[header] !== undefined)) return false

  const rawHost = request.headers.host
  if (typeof rawHost !== 'string' || rawHost.length === 0) return false
  const host = stripPort(rawHost.toLowerCase())
  if (!isLoopbackHostname(host)) return false

  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname.toLowerCase())) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Remove a port suffix from an authority.
 * @param authority - `host` or `host:port`, possibly IPv6 in brackets.
 * @returns the bare hostname.
 */
function stripPort(authority: string): string {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    return end === -1 ? authority : authority.slice(0, end + 1)
  }
  if (authority.split(':').length === 2) return authority.slice(0, authority.lastIndexOf(':'))
  return authority
}

/**
 * Whether a hostname names loopback.
 * @param hostname - lowercase hostname.
 * @returns true for localhost, ::1, and the IPv4 loopback range.
 */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

/**
 * Write one JSON response.
 * @param response - server response.
 * @param status - HTTP status.
 * @param body - JSON-serializable payload.
 */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

/**
 * Build the same-origin bridge the Client panel uses. `GET /status` is readable
 * through the tunnel; every mutation additionally requires a loopback request.
 * @param manager - tunnel owner.
 * @returns the route handler registered as a prefix route.
 */
export function createTunnelRouteHandler(manager: HeluxTunnelManager): TunnelRouteHandler {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://dsh.invalid')
      if (!url.pathname.startsWith(API_PREFIX)) {
        sendJson(response, 404, { ok: false, error: 'Not found' })
        return
      }
      const action = url.pathname.slice(API_PREFIX.length) || '/'
      const method = request.method ?? 'GET'

      if (method === 'GET' && action === '/status') {
        sendJson(response, 200, {
          ...await manager.snapshot(),
          // Cookies and the token are never served through the tunnel, so the
          // Client disables the launch-URL button when this is false.
          launchLocal: isLocalRequest(request),
        })
        return
      }
      if (method !== 'POST') {
        response.setHeader('allow', 'GET, POST')
        sendJson(response, 405, { ok: false, error: 'Method not allowed' })
        return
      }
      if (!isLocalRequest(request)) {
        sendJson(response, 403, {
          ok: false,
          code: 'LOCAL_ONLY',
          error: 'Tunnel control is available only from the local DSH page at http://127.0.0.1:3080.',
        })
        return
      }

      if (action === '/start') {
        sendJson(response, 200, await manager.start())
        return
      }
      if (action === '/stop') {
        sendJson(response, 200, await manager.stop())
        return
      }
      if (action === '/launch-url') {
        sendJson(response, 200, await manager.launchUrl())
        return
      }
      if (action === '/access-check') {
        await manager.probeAccess()
        sendJson(response, 200, await manager.snapshot())
        return
      }
      sendJson(response, 404, { ok: false, error: 'Not found' })
    } catch {
      sendJson(response, 500, { ok: false, error: 'The Helux Tunnel control request failed.' })
    }
  }
}