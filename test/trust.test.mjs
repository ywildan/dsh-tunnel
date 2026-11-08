import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { checkHostTrust } from '../lib/host/prerequisites.js'

// The trust preflight exists because of a real failure: `dsh web` started
// without --trusted-host still serves the page - its index handler performs no
// trust check - while every /api call is refused with 403. The tunnel looked
// ON, the chat rendered, and the folder picker failed.
//
// These tests stand up their own fence so they never depend on a DSH instance
// running on this machine or on the CI runner. The double answers exactly the
// way DSH does: 403 for a Host it was not told to trust, 401 otherwise.

/**
 * Start a fence double.
 * @param trusted - the only Host value it accepts.
 * @returns the loopback URL and a stop function.
 */
async function startFence(trusted) {
  const server = createServer((request, response) => {
    const host = request.headers.host ?? ''
    request.resume()
    request.on('end', () => {
      response.writeHead(host === trusted ? 401 : 403, { 'content-type': 'text/plain' })
      response.end(host === trusted ? 'unauthorized' : 'forbidden')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    localUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('the trust check names --trusted-host when DSH rejects the hostname', async () => {
  const fence = await startFence('helux.web.id')
  try {
    const check = await checkHostTrust(fence.localUrl, 'dsh.example.com', 3_000)
    assert.equal(check.id, 'trust')
    assert.equal(check.ok, false)
    assert.match(check.message, /HTTP 403/)
    assert.match(check.hint ?? '', /--trusted-host dsh\.example\.com/)
    assert.match(check.hint ?? '', /page loads but every \/api call is refused/)
  } finally {
    await fence.stop()
  }
})

test('the trust check passes when DSH accepts the hostname', async () => {
  const fence = await startFence('dsh.example.com')
  try {
    const check = await checkHostTrust(fence.localUrl, 'dsh.example.com', 3_000)
    assert.equal(check.ok, true)
    assert.match(check.message, /accepts dsh\.example\.com/)
  } finally {
    await fence.stop()
  }
})

test('the trust check reads 403 as untrusted, not as a missing credential', async () => {
  // Both answers come from the same fence; only the Host decides which one.
  // This is the distinction the whole check rests on, so pin it directly.
  const fence = await startFence('only-this.example')
  try {
    const untrusted = await checkHostTrust(fence.localUrl, 'other.example', 3_000)
    const trusted = await checkHostTrust(fence.localUrl, 'only-this.example', 3_000)
    assert.equal(untrusted.ok, false)
    assert.equal(trusted.ok, true)
  } finally {
    await fence.stop()
  }
})

test('the trust check reports an unreachable DSH instead of claiming success', async () => {
  // Port 1 is reserved and refuses connections; nothing is listening there.
  const check = await checkHostTrust('http://127.0.0.1:1', 'example.com', 1_500)
  assert.equal(check.ok, false)
  assert.match(check.message, /could not be verified/)
})

test('the trust check refuses to guess when no hostname is known', async () => {
  const check = await checkHostTrust('http://127.0.0.1:3080', '', 1_000)
  assert.equal(check.ok, false)
  assert.match(check.message, /no public hostname/)
})
