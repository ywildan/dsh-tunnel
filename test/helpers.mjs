import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fake `cloudflared` whose behavior is selected through FAKE_CLOUDFLARED_MODE. */
const FAKE_CLOUDFLARED = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const mode = process.env.FAKE_CLOUDFLARED_MODE || 'ready'
const pidFile = process.env.FAKE_CLOUDFLARED_PID_FILE
if (pidFile) writeFileSync(pidFile, String(process.pid))
const log = (line) => process.stderr.write(line + '\\n')
log('2026-11-08T00:00:00Z INF Starting tunnel ' + process.argv.slice(2).join(' '))
if (mode === 'ready') setTimeout(() => log('2026-11-08T00:00:01Z INF Registered tunnel connection connIndex=0'), 60)
else if (mode === 'fatal') setTimeout(() => log('2026-11-08T00:00:01Z ERR failed to authenticate: invalid tunnel secret'), 60)
else if (mode === 'exit') setTimeout(() => process.exit(1), 80)
process.on('SIGTERM', () => { log('2026-11-08T00:00:02Z INF SIGTERM received, shutting down'); process.exit(0) })
setInterval(() => {}, 1000)
`

/**
 * Build a temporary tunnel home with a fake cloudflared, config, credentials,
 * and a listening local service.
 * @returns fixture helpers and paths.
 */
export async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'helux-tunnel-test-'))
  const cloudflaredHome = join(root, 'cloudflared')
  const dshHome = join(root, 'dsh')
  const pidFile = join(root, 'fake.pid')
  await mkdir(cloudflaredHome, { recursive: true })

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('local dsh')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const localUrl = `http://127.0.0.1:${port}`

  const tunnelId = '11111111-2222-3333-4444-555555555555'
  const credentialsFile = join(cloudflaredHome, `${tunnelId}.json`)
  await writeFile(credentialsFile, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: 'c2VjcmV0LXZhbHVl' }))
  const configPath = join(cloudflaredHome, 'config.yml')
  await writeFile(configPath, [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    '',
    'ingress:',
    '  - hostname: helux.web.id',
    `    service: ${localUrl}`,
    '  - service: http_status:404',
    '',
  ].join('\n'))

  const binary = join(root, 'bin', 'cloudflared')
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(binary, FAKE_CLOUDFLARED)
  await chmod(binary, 0o755)
  const missingBinary = join(root, 'not-cloudflared')

  const settings = (overrides = {}) => ({
    cloudflaredPath: binary,
    cloudflaredHome,
    dshHome,
    hostname: 'helux.web.id',
    localUrl,
    ...overrides,
  })

  return {
    root,
    cloudflaredHome,
    dshHome,
    localUrl,
    configPath,
    credentialsFile,
    binary,
    pidFile,
    settings,
    missingBinarySettings: () => settings({ cloudflaredPath: missingBinary }),
    isFakeRunning: async () => {
      try {
        const pid = Number(await readFile(pidFile, 'utf8'))
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    cleanup: async () => {
      try {
        const pid = Number(await readFile(pidFile, 'utf8'))
        process.kill(pid, 'SIGKILL')
      } catch {
        /* not running */
      }
      await new Promise((resolve) => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Poll a predicate until it returns truthy or the timeout expires. A predicate
 * that throws (for example reading a log file the manager has not created yet)
 * counts as "not ready" and is retried.
 * @param predicate - async or sync check.
 * @param timeoutMs - maximum wait.
 * @returns the truthy value.
 */
export async function waitFor(predicate, timeoutMs = 4_000) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`waitFor timed out${lastError === undefined ? '' : `: ${lastError.message}`}`)
}

/**
 * Invoke a tunnel route handler with a minimal request/response pair.
 * @param handler - route handler.
 * @param options - request method, URL, and headers.
 * @returns the captured response.
 */
export function callHandler(handler, options = {}) {
  const { method = 'GET', url = '/api/helux-tunnel/status', headers = { host: '127.0.0.1:3080' } } = options
  return new Promise((resolve) => {
    const request = { method, url, headers }
    const response = {
      statusCode: 0,
      headers: {},
      body: '',
      writeHead(statusCode, responseHeaders) {
        this.statusCode = statusCode
        this.headers = responseHeaders
      },
      setHeader(name, value) {
        this.headers[name] = value
      },
      end(chunk) {
        this.body = chunk === undefined ? '' : String(chunk)
        resolve(this)
      },
    }
    void handler(request, response)
  })
}