import assert from 'node:assert/strict'
import test from 'node:test'
import { createLaunchUrlResolver } from '../lib/index.js'

// Regression for the v2.2.0 QR button bug.
//
// The resolver used to be built from `https://${settings.hostname}` at
// activation. Leaving `hostname` unset is the documented default (the manager
// adopts it from config.yml instead), so that string was "https://" - not a
// URL. `authenticatedUrl` threw, the resolver swallowed it, and the sidebar
// reported `token-missing`: the Pair-device button sat disabled while the
// tunnel was ON, with no way for the user to tell why.

/**
 * Build a Connection double that behaves like DSH's: it parses the base URL and
 * throws on one it cannot.
 * @param requested - array collecting every origin asked for.
 * @returns a HostContext stub.
 */
function contextWith(requested) {
  return {
    get: (name) => name !== 'connection' ? undefined : {
      authenticatedUrl: (baseUrl) => {
        requested.push(baseUrl)
        const url = new URL(baseUrl)
        url.searchParams.set('token', 'token-VALUE')
        return url.href
      },
    },
  }
}

test('the resolver reads the origin at call time, not at construction', () => {
  const requested = []
  // Auto-detect: the hostname does not exist until the first preflight.
  let origin = ''
  const resolve = createLaunchUrlResolver(contextWith(requested), () => origin)

  assert.equal(resolve(), undefined, 'no origin yet means no token request')
  assert.deepEqual(requested, [], 'DSH is never asked for a hostname-less origin')

  // The preflight adopts the hostname from config.yml.
  origin = 'https://dsh.example.com'
  assert.equal(resolve(), 'https://dsh.example.com/?token=token-VALUE')
  assert.deepEqual(requested, ['https://dsh.example.com'])
})

test('a configured hostname resolves immediately', () => {
  const requested = []
  const resolve = createLaunchUrlResolver(contextWith(requested), () => 'https://helux.web.id')
  assert.equal(resolve(), 'https://helux.web.id/?token=token-VALUE')
})

test('an empty origin is refused rather than passed through', () => {
  const requested = []
  const resolve = createLaunchUrlResolver(contextWith(requested), () => '')
  assert.equal(resolve(), undefined)
  assert.deepEqual(requested, [])
})

test('a missing Connection service disables the launch URL instead of throwing', () => {
  const resolve = createLaunchUrlResolver({ get: () => undefined }, () => 'https://helux.web.id')
  assert.equal(resolve(), undefined)
})

test('a Connection service without authenticatedUrl disables it', () => {
  const resolve = createLaunchUrlResolver(
    { get: () => ({ allowsRemoteAuthorities: true }) },
    () => 'https://helux.web.id',
  )
  assert.equal(resolve(), undefined)
})

test('a throwing authenticatedUrl is contained', () => {
  const resolve = createLaunchUrlResolver({
    get: () => ({
      authenticatedUrl: () => {
        throw new Error('token store unavailable')
      },
    }),
  }, () => 'https://helux.web.id')
  assert.equal(resolve(), undefined)
})
