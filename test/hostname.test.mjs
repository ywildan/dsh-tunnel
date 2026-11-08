import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'
import { HeluxTunnelManager } from '../lib/host/manager.js'
import { canSpawnFakeBinary, makeFixture, SPAWN_SKIP_REASON, waitFor } from './helpers.mjs'

// These tests exercise the whole manager against a fake cloudflared, so they
// prove that a deployment on someone else's domain actually starts, reports the
// right public URL, and stops - not merely that the config parses.

/**
 * Point a fixture's config.yml at a different hostname.
 * @param fixture - fixture from makeFixture.
 * @param hostname - hostname to publish.
 */
async function repoint(fixture, hostname) {
  await writeFile(
    fixture.configPath,
    [
      'tunnel: 11111111-2222-3333-4444-555555555555',
      `credentials-file: ${fixture.credentialsFile}`,
      '',
      'ingress:',
      `  - hostname: ${hostname}`,
      `    service: ${fixture.localUrl}`,
      '  - service: http_status:404',
      '',
    ].join('\n'),
  )
}

test('a configured hostname is what the tunnel actually publishes', { skip: canSpawnFakeBinary ? false : SPAWN_SKIP_REASON }, async () => {
  const fixture = await makeFixture()
  try {
    await repoint(fixture, 'dsh.example.com')
    const manager = new HeluxTunnelManager({
      settings: fixture.settings({ hostname: 'dsh.example.com' }),
    })
    try {
      const snapshot = await manager.snapshot()
      assert.equal(snapshot.publicUrl, 'https://dsh.example.com')
      assert.equal(snapshot.localUrl, fixture.localUrl, 'the local URL is reported from config')

      const start = await manager.start()
      assert.equal(start.ok, true, start.error)
      await waitFor(async () => (await manager.snapshot()).status === 'on')
      assert.equal((await manager.snapshot()).publicUrl, 'https://dsh.example.com')

      const log = await manager.snapshot()
      assert.ok(
        log.logs.some((line) => line.includes('TUNNEL_ON https://dsh.example.com')),
        'the log names the configured host, not a hard-coded one',
      )

      const stop = await manager.stop()
      assert.equal(stop.ok, true)
      assert.equal((await manager.snapshot()).status, 'off')
    } finally {
      await manager.dispose()
    }
  } finally {
    await fixture.cleanup()
  }
})

test('an unconfigured manager adopts the hostname from config.yml', async () => {
  const fixture = await makeFixture()
  try {
    await repoint(fixture, 'someone-else.example.org')
    // hostname: '' is what an unconfigured plugin row produces.
    const manager = new HeluxTunnelManager({ settings: fixture.settings({ hostname: '' }) })
    try {
      const snapshot = await manager.snapshot()
      assert.equal(snapshot.publicUrl, 'https://someone-else.example.org')
      assert.equal(snapshot.prereqsOk, true, JSON.stringify(snapshot.prereqs))
    } finally {
      await manager.dispose()
    }
  } finally {
    await fixture.cleanup()
  }
})

test('a hostname that config.yml does not publish blocks the start with a readable error', async () => {
  const fixture = await makeFixture()
  try {
    await repoint(fixture, 'dsh.example.com')
    const manager = new HeluxTunnelManager({
      settings: fixture.settings({ hostname: 'typo.example.com' }),
    })
    try {
      const start = await manager.start()
      assert.equal(start.ok, false)
      assert.equal(start.code, 'PREREQUISITES')
      assert.match(start.error ?? '', /no ingress entry for typo\.example\.com/)
      assert.match(start.error ?? '', /declares: dsh\.example\.com/)
      assert.equal(await fixture.isFakeRunning(), false, 'nothing is spawned when the config does not match')
    } finally {
      await manager.dispose()
    }
  } finally {
    await fixture.cleanup()
  }
})
