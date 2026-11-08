import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createTunnelRouteHandler, isLocalRequest } from '../lib/host/api.js'
import { HeluxTunnelManager } from '../lib/host/manager.js'
import { parseTunnelConfig } from '../lib/host/prerequisites.js'
import { callHandler, canSpawnFakeBinary, makeFixture, SPAWN_SKIP_REASON, waitFor } from './helpers.mjs'

/** Read the persisted state file for a fixture. */
async function readState(dshHome) {
  return JSON.parse(await readFile(join(dshHome, 'data', 'helux-tunnel', 'state.json'), 'utf8'))
}

test('config parser accepts the named-tunnel shape and rejects a wrong service', () => {
  const settings = {
    cloudflaredHome: '/tmp/cloudflared',
    dshHome: '/tmp/dsh',
    hostname: 'helux.web.id',
    localUrl: 'http://127.0.0.1:3080',
  }
  const good = parseTunnelConfig([
    '# comment',
    'tunnel: "11111111-2222-3333-4444-555555555555"',
    'credentials-file: /tmp/cloudflared/creds.json',
    'ingress:',
    '  - hostname: helux.web.id   # apex',
    '    service: http://127.0.0.1:3080',
    '  - service: http_status:404',
  ].join('\n'), settings)
  assert.equal(good.error, undefined)
  assert.equal(good.config?.tunnelId, '11111111-2222-3333-4444-555555555555')
  assert.equal(good.config?.credentialsFile, '/tmp/cloudflared/creds.json')

  const wrong = parseTunnelConfig([
    'tunnel: x',
    'ingress:',
    '  - hostname: helux.web.id',
    '    service: http://127.0.0.1:9999',
  ].join('\n'), settings)
  assert.match(wrong.error ?? '', /requires http:\/\/127\.0\.0\.1:3080/)

  const absent = parseTunnelConfig('tunnel: x\ningress:\n  - service: http_status:404\n', settings)
  assert.match(absent.error ?? '', /no ingress entry for helux\.web\.id/)
})

test('initialization starts nothing and persists OFF even after a stored ON', async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.settings() })
  try {
    await mkdir(join(fixture.dshHome, 'data', 'helux-tunnel'), { recursive: true })
    await writeFile(join(fixture.dshHome, 'data', 'helux-tunnel', 'state.json'), JSON.stringify({ enabled: true, status: 'on' }))

    await manager.initialize()
    const snapshot = await manager.snapshot()
    assert.equal(snapshot.status, 'off')
    assert.equal(snapshot.autoStart, false)
    assert.equal(await fixture.isFakeRunning(), false)

    const state = await readState(fixture.dshHome)
    assert.equal(state.enabled, false)
    assert.match(state.note, /never resumed/)
    assert.ok(snapshot.logs.some((line) => line.includes('plugin loaded: tunnel is OFF')))
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('a second manager after restart begins OFF', async () => {
  const fixture = await makeFixture()
  const first = new HeluxTunnelManager({ settings: fixture.settings() })
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'ready'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await first.initialize()
    const started = await first.start()
    assert.equal(started.ok, true)
    await waitFor(async () => (await first.snapshot()).status === 'on')
  } finally {
    await first.dispose()
    await fixture.cleanup()
  }

  const fixture2 = await makeFixture()
  const second = new HeluxTunnelManager({ settings: fixture2.settings() })
  try {
    await second.initialize()
    assert.equal((await second.snapshot()).status, 'off')
    assert.equal(await fixture2.isFakeRunning(), false)
  } finally {
    await second.dispose()
    await fixture2.cleanup()
  }
})

test('start refuses visibly when cloudflared is missing', async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.missingBinarySettings() })
  try {
    await manager.initialize()
    const result = await manager.start()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PREREQUISITES')
    assert.match(result.error ?? '', /cloudflared is not installed/)
    assert.equal(result.snapshot.status, 'error')
    assert.ok(result.snapshot.prereqs.some((check) => check.id === 'cloudflared' && !check.ok))
    assert.equal(await fixture.isFakeRunning(), false)
    assert.equal((await readState(fixture.dshHome)).enabled, false)
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('ON registers, reports uptime metadata, then OFF kills the child', { skip: canSpawnFakeBinary ? false : SPAWN_SKIP_REASON }, async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.settings() })
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'ready'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await manager.initialize()

    const started = await manager.start()
    assert.equal(started.ok, true)
    assert.equal(started.snapshot.status, 'connecting')

    const on = await waitFor(async () => {
      const snapshot = await manager.snapshot()
      return snapshot.status === 'on' ? snapshot : undefined
    })
    assert.equal(on.publicUrl, 'https://helux.web.id')
    assert.equal(on.prereqsOk, true)
    assert.ok(on.startedAt !== null)
    assert.ok(on.logs.some((line) => line.includes('TUNNEL_ON https://helux.web.id')))
    assert.equal(await fixture.isFakeRunning(), true)
    assert.equal((await readState(fixture.dshHome)).enabled, true)

    const stopped = await manager.stop()
    assert.equal(stopped.ok, true)
    assert.equal(stopped.snapshot.status, 'off')
    assert.ok(stopped.snapshot.logs.some((line) => line.includes('TUNNEL_OFF')))
    await waitFor(async () => (await fixture.isFakeRunning()) === false)
    assert.equal((await readState(fixture.dshHome)).enabled, false)
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('dispose kills a running child', { skip: canSpawnFakeBinary ? false : SPAWN_SKIP_REASON }, async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.settings() })
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'ready'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await manager.initialize()
    await manager.start()
    await waitFor(async () => (await manager.snapshot()).status === 'on')
    assert.equal(await fixture.isFakeRunning(), true)

    await manager.dispose()
    await waitFor(async () => (await fixture.isFakeRunning()) === false)
  } finally {
    await fixture.cleanup()
  }
})

test('an unexpected child exit surfaces as ERROR', { skip: canSpawnFakeBinary ? false : SPAWN_SKIP_REASON }, async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.settings() })
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'exit'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await manager.initialize()
    const started = await manager.start()
    assert.equal(started.ok, true)
    const failed = await waitFor(async () => {
      const snapshot = await manager.snapshot()
      return snapshot.status === 'error' ? snapshot : undefined
    })
    assert.equal(failed.errorCode, 'EXITED')
    assert.match(failed.error ?? '', /exited unexpectedly/)
    assert.ok(failed.logs.some((line) => line.includes('ERROR EXITED')))
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('an authentication failure line surfaces as ERROR and stops the child', { skip: canSpawnFakeBinary ? false : SPAWN_SKIP_REASON }, async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.settings() })
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'fatal'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await manager.initialize()
    await manager.start()
    const failed = await waitFor(async () => {
      const snapshot = await manager.snapshot()
      return snapshot.status === 'error' ? snapshot : undefined
    })
    assert.equal(failed.errorCode, 'CLOUDFLARED')
    assert.match(failed.error ?? '', /authentication or tunnel error/)
    await waitFor(async () => (await fixture.isFakeRunning()) === false)
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('the Access probe distinguishes an Access redirect from a public response', async () => {
  const fixture = await makeFixture()
  let probeResult = { status: 302, location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login' }
  const manager = new HeluxTunnelManager({
    settings: fixture.settings(),
    probe: async () => probeResult,
  })
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'ready'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await manager.initialize()
    await manager.start()
    await waitFor(async () => (await manager.snapshot()).access === 'access')

    probeResult = { status: 200, location: '' }
    await manager.probeAccess()
    assert.equal((await manager.snapshot()).access, 'public')

    // DSH's own 401 must not be reported as Access protection.
    probeResult = { status: 401, location: '', body: 'dsh web authentication required; reopen the URL printed by dsh web.\n' }
    await manager.probeAccess()
    assert.equal((await manager.snapshot()).access, 'public')

    // A refusal that is not DSH's fence stays Access-like.
    probeResult = { status: 403, location: '', body: 'Forbidden' }
    await manager.probeAccess()
    assert.equal((await manager.snapshot()).access, 'access')
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('the HTTP bridge allows status but rejects tunneled mutations', async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.missingBinarySettings() })
  const handler = createTunnelRouteHandler(manager)
  try {
    await manager.initialize()

    const status = await callHandler(handler, {
      method: 'GET',
      url: '/api/helux-tunnel/status',
      headers: { host: 'helux.web.id' },
    })
    assert.equal(status.statusCode, 200)
    assert.equal(JSON.parse(status.body).status, 'off')

    const tunneled = await callHandler(handler, {
      method: 'POST',
      url: '/api/helux-tunnel/start',
      headers: { host: '127.0.0.1:3080', 'cf-connecting-ip': '203.0.113.9' },
    })
    assert.equal(tunneled.statusCode, 403)
    assert.equal(JSON.parse(tunneled.body).code, 'LOCAL_ONLY')

    const proxied = await callHandler(handler, {
      method: 'POST',
      url: '/api/helux-tunnel/start',
      headers: { host: '127.0.0.1:3080', 'x-forwarded-for': '203.0.113.9' },
    })
    assert.equal(proxied.statusCode, 403)

    const local = await callHandler(handler, {
      method: 'POST',
      url: '/api/helux-tunnel/start',
      headers: { host: '127.0.0.1:3080' },
    })
    assert.equal(local.statusCode, 200)
    assert.equal(JSON.parse(local.body).ok, false)
    assert.equal(JSON.parse(local.body).code, 'PREREQUISITES')

    assert.equal(isLocalRequest({ headers: { host: 'localhost:3080' } }), true)
    assert.equal(isLocalRequest({ headers: { host: '[::1]:3080' } }), true)
    assert.equal(isLocalRequest({ headers: { host: '127.0.0.1:3080', 'cf-ray': 'abc' } }), false)
    assert.equal(isLocalRequest({ headers: { host: 'helux.web.id' } }), false)
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('the launch URL is masked, local-only, and never written to disk', async () => {
  const fixture = await makeFixture()
  const token = 'launch-token-SECRET-abcd'
  const expectedUrl = `https://helux.web.id/?token=${token}`
  const manager = new HeluxTunnelManager({
    settings: fixture.settings(),
    resolveLaunchUrl: () => expectedUrl,
  })
  const handler = createTunnelRouteHandler(manager)
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'ready'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await manager.initialize()

    const off = await manager.snapshot()
    assert.equal(off.launchUrlAvailable, false)
    assert.equal(off.launchUrlPreview, null)
    assert.equal(off.launchUrlReason, 'off')
    assert.equal((await manager.launchUrl()).code, 'TUNNEL_OFF')

    await manager.start()
    await waitFor(async () => (await manager.snapshot()).status === 'on')

    const snapshot = await manager.snapshot()
    assert.equal(snapshot.launchUrlAvailable, true)
    assert.equal(snapshot.launchUrlPreview, 'https://helux.web.id/?token=••••abcd')
    assert.equal(snapshot.launchUrlReason, null)
    assert.ok(!JSON.stringify(snapshot).includes(token), 'the snapshot must carry only the masked token')

    const localStatus = await callHandler(handler, {
      method: 'GET',
      url: '/api/helux-tunnel/status',
      headers: { host: '127.0.0.1:3080' },
    })
    assert.equal(JSON.parse(localStatus.body).launchLocal, true)

    const remoteStatus = await callHandler(handler, {
      method: 'GET',
      url: '/api/helux-tunnel/status',
      headers: { host: 'helux.web.id', 'cf-connecting-ip': '203.0.113.9' },
    })
    assert.equal(JSON.parse(remoteStatus.body).launchLocal, false)

    const localCopy = await callHandler(handler, {
      method: 'POST',
      url: '/api/helux-tunnel/launch-url',
      headers: { host: '127.0.0.1:3080' },
    })
    assert.equal(localCopy.statusCode, 200)
    assert.equal(JSON.parse(localCopy.body).url, expectedUrl)
    assert.equal(JSON.parse(localCopy.body).preview, 'https://helux.web.id/?token=••••abcd')

    const remoteCopy = await callHandler(handler, {
      method: 'POST',
      url: '/api/helux-tunnel/launch-url',
      headers: { host: 'helux.web.id' },
    })
    assert.equal(remoteCopy.statusCode, 403)
    assert.equal(JSON.parse(remoteCopy.body).code, 'LOCAL_ONLY')
    assert.ok(!remoteCopy.body.includes(token), 'a remote response must not leak the token')

    await manager.stop()
    const stopped = await manager.snapshot()
    assert.equal(stopped.launchUrlAvailable, false)
    assert.equal(stopped.launchUrlPreview, null)
    assert.equal((await manager.launchUrl()).code, 'TUNNEL_OFF')

    const log = await readFile(join(fixture.dshHome, 'logs', 'helux-tunnel.log'), 'utf8')
    const state = await readFile(join(fixture.dshHome, 'data', 'helux-tunnel', 'state.json'), 'utf8')
    assert.ok(!log.includes(token), 'the token must never reach the log file')
    assert.ok(!state.includes(token), 'the token must never reach the state file')
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})

test('the launch URL stays disabled when DSH exposes no token', async () => {
  const fixture = await makeFixture()
  const manager = new HeluxTunnelManager({ settings: fixture.settings() })
  try {
    process.env.FAKE_CLOUDFLARED_MODE = 'ready'
    process.env.FAKE_CLOUDFLARED_PID_FILE = fixture.pidFile
    await manager.initialize()
    await manager.start()
    await waitFor(async () => (await manager.snapshot()).status === 'on')

    const snapshot = await manager.snapshot()
    assert.equal(snapshot.launchUrlAvailable, false)
    assert.equal(snapshot.launchUrlReason, 'token-missing')
    assert.equal(snapshot.launchUrlPreview, null)

    const result = await manager.launchUrl()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'TOKEN_MISSING')
    assert.match(result.error ?? '', /^Token not found - open the URL printed by dsh web in its terminal$/)
  } finally {
    await manager.dispose()
    await fixture.cleanup()
  }
})
