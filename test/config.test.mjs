import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Config, resolveConfig, toTunnelSettings, expandHome } from '../lib/host/config.js'
import { parseTunnelConfig } from '../lib/host/prerequisites.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Settings with nothing configured, as an unconfigured install would have. */
const bare = {
  cloudflaredHome: '/tmp/cloudflared',
  dshHome: '/tmp/dsh',
  hostname: '',
  localUrl: 'http://127.0.0.1:3080',
}

/**
 * A config.yml shaped like the one `cloudflared tunnel create` produces.
 * @param hostname - ingress hostname.
 * @param service - ingress service.
 * @returns YAML text.
 */
function configFor(hostname, service = 'http://127.0.0.1:3080') {
  return [
    'tunnel: 11111111-2222-3333-4444-555555555555',
    'credentials-file: /tmp/cloudflared/creds.json',
    '',
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: ${service}`,
    '  - service: http_status:404',
    '',
  ].join('\n')
}

test('an unconfigured install publishes nothing until config.yml is read', () => {
  const config = resolveConfig({})
  assert.equal(config.hostname, '', 'no hostname is invented')
  assert.equal(config.localUrl, 'http://127.0.0.1:3080', 'the local service default is unchanged')
  assert.equal(config.accessCheck, true)
})

test('the hostname is adopted from config.yml, so no plugin config is required', () => {
  const parsed = parseTunnelConfig(configFor('dsh.example.com'), bare)
  assert.equal(parsed.error, undefined)
  assert.equal(parsed.hostname, 'dsh.example.com')
})

test('an explicit hostname selects among several ingress rows', () => {
  const twoHosts = [
    'tunnel: 11111111-2222-3333-4444-555555555555',
    'ingress:',
    '  - hostname: a.example.com',
    '    service: http://127.0.0.1:3080',
    '  - hostname: b.example.com',
    '    service: http://127.0.0.1:3080',
    '  - service: http_status:404',
    '',
  ].join('\n')

  const ambiguous = parseTunnelConfig(twoHosts, bare)
  assert.match(ambiguous.error ?? '', /several hostnames/)
  assert.match(ambiguous.error ?? '', /Set the plugin's "hostname" option/)

  const chosen = parseTunnelConfig(twoHosts, { ...bare, hostname: 'b.example.com' })
  assert.equal(chosen.hostname, 'b.example.com')
})

test('auto-detection ignores the catch-all 404 row', () => {
  const parsed = parseTunnelConfig(configFor('dsh.example.com'), bare)
  assert.equal(parsed.hostname, 'dsh.example.com', 'a hostname-less ingress row is never adopted')
})

test('an explicit hostname must still match its ingress service', () => {
  const parsed = parseTunnelConfig(
    configFor('dsh.example.com', 'http://127.0.0.1:9999'),
    { ...bare, hostname: 'dsh.example.com' },
  )
  assert.match(parsed.error ?? '', /routes dsh\.example\.com to/)
})

test('a hostname that is absent from config.yml is named in the error', () => {
  const parsed = parseTunnelConfig(configFor('dsh.example.com'), { ...bare, hostname: 'other.example.com' })
  assert.match(parsed.error ?? '', /no ingress entry for other\.example\.com/)
  assert.match(parsed.error ?? '', /It declares: dsh\.example\.com/)
})

test('a hostname must be a bare DNS name, never a URL or a wildcard', () => {
  const accepted = ['dsh.example.com', 'DSH.Example.com', 'a-b.example.co.id']
  for (const hostname of accepted) {
    assert.ok(resolveConfig({ hostname }).hostname.length > 0, `${hostname} should be accepted`)
  }
  const rejected = [
    'https://dsh.example.com',
    'dsh.example.com/path',
    'dsh.example.com:8443',
    '*.example.com',
    'localhost',
    'not a host',
  ]
  for (const hostname of rejected) {
    assert.throws(() => resolveConfig({ hostname }), /hostname/, `${hostname} should be rejected`)
  }
})

test('the local service must be loopback, so the tunnel cannot proxy another host', () => {
  assert.equal(resolveConfig({ localUrl: 'http://127.0.0.1:3080' }).localUrl, 'http://127.0.0.1:3080')
  assert.equal(resolveConfig({ localUrl: 'http://localhost:3080/' }).localUrl, 'http://localhost:3080')
  assert.throws(() => resolveConfig({ localUrl: 'http://203.0.113.9:3080' }), /loopback|this machine/)
  assert.throws(() => resolveConfig({ localUrl: 'ftp://127.0.0.1:3080' }), /http or https/)
  assert.throws(() => resolveConfig({ localUrl: 'http://127.0.0.1:3080/app' }), /path/)
})

test('a ~ path in config is expanded so Windows and POSIX both resolve', () => {
  assert.match(expandHome('~/.cloudflared'), /\.cloudflared$/)
  assert.doesNotMatch(expandHome('~/.cloudflared'), /^~/)
  assert.equal(expandHome('/absolute/path'), '/absolute/path')
})

test('toTunnelSettings carries the configured hostname and drops an empty binary path', () => {
  const settings = toTunnelSettings(resolveConfig({ hostname: 'dsh.example.com', cloudflaredPath: '' }))
  assert.equal(settings.hostname, 'dsh.example.com')
  assert.equal(settings.cloudflaredPath, undefined, 'an empty path must fall back to PATH lookup')
})

test('the declared Config schema exposes every option with a usable default', () => {
  const defaults = Config({})
  assert.equal(defaults.hostname, '', 'unset hostname means auto-detect')
  assert.equal(defaults.localUrl, 'http://127.0.0.1:3080')
  assert.equal(defaults.accessCheck, true)
  assert.equal(defaults.cloudflaredPath, '')
  assert.equal(defaults.cloudflaredHome, '')
})

test('nothing in the shipped plugin still hard-codes a single hostname', () => {
  const files = ['src/host/manager.ts', 'src/host/prerequisites.ts', 'src/index.ts', 'src/client/index.tsx']
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    assert.ok(
      !text.includes('helux.web.id'),
      `${file} must not hard-code helux.web.id; the hostname comes from config or config.yml`,
    )
  }
})

// The trust preflight exists because of a real failure: `dsh web` started
// without --trusted-host still serves the page (authorizeIndex performs no
// trust check) while every /api call is refused with 403. The tunnel looked ON,
// the chat rendered, and the folder picker failed. The check below turns that
// into a visible red item with the exact restart command.
test('the trust preflight names --trusted-host when DSH rejects the hostname', async () => {
  const { checkHostTrust } = await import('../lib/host/prerequisites.js')
  const check = await checkHostTrust('http://127.0.0.1:3080', 'definitely-not-trusted.example', 3_000)
  assert.equal(check.id, 'trust')
  assert.equal(check.ok, false)
  assert.match(check.message, /HTTP 403/)
  assert.match(check.hint ?? '', /--trusted-host definitely-not-trusted\.example/)
  assert.match(check.hint ?? '', /page loads but every \/api call is refused/)
})

test('the trust preflight passes for a loopback authority DSH accepts', async () => {
  const { checkHostTrust } = await import('../lib/host/prerequisites.js')
  // A loopback Host is always accepted by DSH's fence, so this proves the probe
  // reads the 401/403 distinction instead of always failing.
  const check = await checkHostTrust('http://127.0.0.1:3080', 'localhost', 3_000)
  assert.equal(check.ok, true)
  assert.match(check.message, /accepts localhost/)
})

test('the trust preflight reports an unreachable DSH instead of claiming success', async () => {
  const { checkHostTrust } = await import('../lib/host/prerequisites.js')
  const check = await checkHostTrust('http://127.0.0.1:1', 'example.com', 1_500)
  assert.equal(check.ok, false)
  assert.match(check.message, /could not be verified/)
})
