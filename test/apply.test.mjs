import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { waitFor } from './helpers.mjs'

// This file keeps the apply test hermetic. It sets HOME before importing the
// plugin so DEFAULT_CLOUDFLARED_HOME points at a missing directory even on the
// machine that owns the real named tunnel. Static imports would evaluate the
// constants first, hence the dynamic import below.
test('apply registers three tools, the bridge, and never auto-starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helux-apply-'))
  const dshHome = join(root, 'dsh')
  const previousDshHome = process.env.DSH_HOME
  const previousUserHome = process.env.HOME
  process.env.DSH_HOME = dshHome
  process.env.HOME = join(root, 'home')

  const tools = new Map()
  const routes = []
  const effects = []
  const context = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => undefined
      },
    },
    effect: (callback) => {
      effects.push(callback())
    },
    logger: { warn: () => undefined },
  }

  try {
    const { apply: applyHost } = await import('../lib/index.js')
    // Explicit hostname: an unconfigured row adopts config.yml instead, which is
    // covered by config.test.mjs.
    applyHost(context, { hostname: 'helux.web.id' })
    assert.equal(tools.size, 3)
    assert.deepEqual([...tools.keys()].sort(), ['tunnel_start', 'tunnel_status', 'tunnel_stop'])
    assert.match(tools.get('tunnel_start').description, /ONLY when the user explicitly asks/)
    assert.equal(routes.length, 1)
    assert.equal(routes[0].path, '/api/helux-tunnel')
    assert.equal(routes[0].kind, 'prefix')

    const status = await tools.get('tunnel_status').execute({}, {})
    assert.equal(status.status, 'off')
    assert.equal(status.publicUrl, 'https://helux.web.id')

    const start = await tools.get('tunnel_start').execute({}, {})
    assert.equal(start.ok, false)
    assert.equal(start.code, 'PREREQUISITES')

    const stop = await tools.get('tunnel_stop').execute({}, {})
    assert.equal(stop.ok, true)
    assert.equal(stop.status, 'off')

    for (const dispose of effects.reverse()) {
      if (typeof dispose === 'function') dispose()
    }
    // The initial persist happens before the preflight line, so waiting for
    // "preflight" guarantees state.json exists; waiting for "plugin loaded"
    // would race the first write.
    await waitFor(async () => {
      const records = await readFile(join(dshHome, 'logs', 'helux-tunnel.log'), 'utf8')
      return records.includes('preflight')
    })
    const state = JSON.parse(await readFile(join(dshHome, 'data', 'helux-tunnel', 'state.json'), 'utf8'))
    assert.equal(state.enabled, false)
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    if (previousUserHome === undefined) delete process.env.HOME
    else process.env.HOME = previousUserHome
    await rm(root, { recursive: true, force: true })
  }
})