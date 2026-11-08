import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

test('the Client bundle registers the panel and sidebar entry without starting anything', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const window = {
    __ModuleLoader__: {
      load(candidate) {
        registration = candidate
      },
    },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (value) => [value, () => undefined],
    useEffect: () => undefined,
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
  }
  let fetchCount = 0
  const context = {
    window,
    require: (id) => {
      if (id === 'react') return react
      throw new Error(`unexpected module: ${id}`)
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      fetchCount += 1
      throw new Error('apply must not fetch')
    },
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })

  assert.equal(registration.id, 'dsh-helux-tunnel')
  const module = registration.factory(context.require)
  assert.deepEqual([...module.inject], ['slots', 'locale'])

  const dictionaries = new Map()
  const registered = []
  const injected = []
  const translations = []
  const clientContext = {
    locale: {
      register(namespace, value) {
        dictionaries.set(namespace, value)
        return () => undefined
      },
      bind(namespace) {
        return (key) => {
          translations.push(key)
          return dictionaries.get(namespace)?.en[key] ?? key
        }
      },
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => undefined
      },
    },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') dispose()
    },
  }

  module.apply(clientContext)

  assert.deepEqual(injected, ['main', 'sidebar.panellist'])
  assert.equal(dictionaries.get('heluxTunnel')?.en.panel, 'Helux Tunnel')
  assert.equal(dictionaries.get('heluxTunnel')?.zh.panel, 'Helux 隧道')
  assert.ok(dictionaries.get('heluxTunnel')?.en['off.message'].includes('http://127.0.0.1:3080'))

  const panel = registered.find((entry) => entry.options.name === 'main')
  assert.equal(panel?.options.key, 'helux-tunnel')
  assert.equal(panel?.options.locale, 'heluxTunnel')
  assert.equal(typeof panel?.component, 'function')

  const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(sidebar?.options.id, 'helux-tunnel')
  assert.equal(sidebar?.options.order, 30)
  assert.equal(sidebar?.options.label(), 'Helux Tunnel')
  assert.equal(typeof sidebar?.component, 'function')
  assert.equal(sidebar?.component({ size: 24, active: true }).type, 'svg')
  assert.equal(fetchCount, 0, 'applying the Client half must not call the Host bridge')
})
/**
 * Create a hook-aware React stub good enough for one render pass.
 * @returns the stub, its state array, and a cursor reset.
 */
function makeRenderReact() {
  const state = []
  let cursor = 0
  return {
    state,
    reset() {
      cursor = 0
    },
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], () => undefined]
    },
    useEffect() {},
    useCallback(callback) {
      return callback
    },
    useRef(value) {
      return { current: value }
    },
  }
}

/**
 * Depth-first search for rendered nodes.
 * @param node - rendered node or child value.
 * @param predicate - match test.
 * @param found - accumulator.
 * @returns matching nodes.
 */
function collect(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) collect(child, predicate, found)
  return found
}

test('the panel renders the OFF, ON, and ERROR states', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let registration
  const react = makeRenderReact()
  const window = { __ModuleLoader__: { load(candidate) { registration = candidate } } }
  const context = {
    window,
    require: (id) => {
      if (id === 'react') return react
      throw new Error(`unexpected module: ${id}`)
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error('render must not fetch')
    },
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  const module = registration.factory(context.require)

  const dictionaries = new Map()
  const registered = []
  module.apply({
    locale: {
      register(namespace, value) {
        dictionaries.set(namespace, value)
        return () => undefined
      },
      bind: (namespace) => (key) => dictionaries.get(namespace)?.en[key] ?? key,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => registered.push({ options, component }),
    },
    effect: (callback) => callback(),
  })
  const panel = registered.find((entry) => entry.options.name === 'main').component
  const t = (key) => dictionaries.get('heluxTunnel')?.en[key] ?? key

  const base = {
    status: 'off',
    error: null,
    errorCode: null,
    startedAt: null,
    stoppedAt: null,
    uptimeMs: 0,
    publicUrl: 'https://helux.web.id',
    access: 'unknown',
    accessCheckedAt: null,
    accessChecking: false,
    prereqs: [{ id: 'cloudflared', ok: true, message: 'cloudflared binary found.' }],
    prereqsOk: true,
    logs: ['[2026-11-08T00:00:00.000Z] [helux-tunnel] plugin loaded'],
    busy: false,
    autoStart: false,
    remoteAuthorities: null,
    launchUrlAvailable: false,
    launchUrlPreview: null,
    launchUrlReason: 'off',
    launchLocal: true,
    checkedAt: 0,
  }

  const render = (snapshot) => {
    react.state[0] = snapshot
    react.reset()
    return panel({ t })
  }

  const loading = render(null)
  assert.equal(loading.type, 'div')
  assert.equal(loading.props.className, 'ht-root')
  assert.ok(collect(loading, (node) => String(node.props.className).includes('ht-status-off')).length > 0)

  const off = render(base)
  assert.ok(collect(off, (node) => node.props.className === 'ht-off-message').length > 0)
  assert.ok(collect(off, (node) => typeof node.children?.[0] === 'string' && node.children[0].includes('http://127.0.0.1:3080')).length > 0)
  const offLaunch = collect(off, (node) => node.type === 'button' && node.children?.[0] === 'Copy launch URL')
  assert.equal(offLaunch.length, 1)
  assert.equal(offLaunch[0].props.disabled, true, 'the launch button is disabled while OFF')
  assert.ok(collect(off, (node) => node.children?.[0] === 'Tunnel is OFF. Turn it ON to copy the launch URL.').length > 0)

  const on = render({
    ...base,
    status: 'on',
    startedAt: Date.now() - 65_000,
    access: 'public',
    launchUrlAvailable: true,
    launchUrlPreview: 'https://helux.web.id/?token=••••abcd',
    launchUrlReason: null,
    launchLocal: true,
  })
  assert.ok(collect(on, (node) => String(node.props.className).includes('ht-switch-on')).length > 0)
  assert.ok(collect(on, (node) => node.props.className === 'ht-url').length > 0)
  assert.ok(collect(on, (node) => String(node.props.className).includes('ht-banner-danger')).length > 0)
  assert.ok(collect(on, (node) => String(node.props.className).includes('ht-status-on')).length > 0)
  assert.ok(collect(on, (node) => node.props.className === 'ht-logs').length > 0)
  const onLaunch = collect(on, (node) => node.type === 'button' && node.children?.[0] === 'Copy launch URL')
  assert.equal(onLaunch.length, 1)
  assert.equal(onLaunch[0].props.disabled, false, 'the launch button is enabled when ON and local')
  assert.ok(collect(on, (node) => node.children?.[0] === 'https://helux.web.id/?token=••••abcd').length > 0, 'the masked preview is shown')

  const onQr = collect(on, (node) => node.type === 'button' && node.children?.[0] === 'Pair device (QR)')
  assert.equal(onQr.length, 1, 'the QR button is rendered when ON')
  assert.equal(onQr[0].props.disabled, false, 'the QR button is enabled when ON and local')
  assert.equal(onQr[0].props['aria-expanded'], false, 'no QR is open until the user asks')
  assert.equal(collect(on, (node) => String(node.props.className).includes('ht-qr')).length, 0, 'no QR is drawn until the user asks')

  const offQr = collect(off, (node) => node.type === 'button' && node.children?.[0] === 'Pair device (QR)')
  assert.equal(offQr.length, 1, 'the QR button is still shown while OFF')
  assert.equal(offQr[0].props.disabled, true, 'the QR button is disabled while OFF')

  const tokenless = render({
    ...base,
    status: 'on',
    startedAt: Date.now(),
    launchUrlAvailable: false,
    launchUrlReason: 'token-missing',
    launchLocal: true,
  })
  const tokenlessLaunch = collect(tokenless, (node) => node.type === 'button' && node.children?.[0] === 'Copy launch URL')
  assert.equal(tokenlessLaunch.length, 1)
  assert.equal(tokenlessLaunch[0].props.disabled, true, 'the launch button is disabled without a token')
  assert.ok(collect(tokenless, (node) => node.children?.[0] === 'Token not found - open the URL printed by dsh web in its terminal').length > 0)

  const remote = render({
    ...base,
    status: 'on',
    startedAt: Date.now(),
    launchUrlAvailable: true,
    launchUrlPreview: 'https://helux.web.id/?token=••••abcd',
    launchUrlReason: null,
    launchLocal: false,
  })
  const remoteLaunch = collect(remote, (node) => node.type === 'button' && node.children?.[0] === 'Copy launch URL')
  assert.equal(remoteLaunch[0].props.disabled, true, 'the launch button is disabled for tunneled pages')
  const remoteQr = collect(remote, (node) => node.type === 'button' && node.children?.[0] === 'Pair device (QR)')
  assert.equal(remoteQr[0].props.disabled, true, 'the QR button is disabled for tunneled pages')

  assert.equal(
    dictionaries.get('heluxTunnel')?.en['launch.toast'],
    'Launch URL copied - do not share, it is like a password',
  )
  assert.equal(dictionaries.get('heluxTunnel')?.zh['launch.copy'], '复制启动链接')

  // Opening the QR renders one SVG path, shows the warning, and never exposes
  // the full launch URL in the rendered tree.
  const secretUrl = 'https://helux.web.id/?token=SUPERSECRETTOKEN1234567890abcdefghij'
  const qrSnapshot = {
    ...base,
    status: 'on',
    startedAt: Date.now(),
    launchUrlAvailable: true,
    launchUrlPreview: 'https://helux.web.id/?token=••••ghij',
    launchUrlReason: null,
    launchLocal: true,
  }
  react.state[0] = qrSnapshot
  react.state[7] = { preview: 'https://helux.web.id/?token=••••ghij', matrix: { size: 21, dark: (r, c) => (r + c) % 2 === 0 } }
  react.reset()
  const withQr = panel({ t })

  const qrSvg = collect(withQr, (node) => node.type === 'svg')
  assert.equal(qrSvg.length, 1, 'exactly one QR svg is rendered')
  assert.equal(qrSvg[0].props.viewBox, '0 0 29 29', 'the quiet zone is included in the view box')
  const qrPath = collect(withQr, (node) => node.type === 'path')
  assert.equal(qrPath.length, 1, 'the QR is drawn as a single path')
  assert.match(String(qrPath[0].props.d), /^M4 4h1v1h-1z/, 'modules start after the quiet zone')
  assert.ok(collect(withQr, (node) => node.children?.[0] === 'This QR contains the launch token - treat it like a password. Do not photograph or share it.').length > 0)
  const hideButton = collect(withQr, (node) => node.type === 'button' && node.children?.[0] === 'Hide QR')
  // One is the URL-row toggle (now reading "Hide QR"), one closes the panel.
  assert.equal(hideButton.length, 2, 'an open QR offers the toggle and a close button')
  assert.ok(hideButton.every((node) => node.props.disabled !== true), 'both hide controls stay enabled')
  assert.equal(
    JSON.stringify(withQr).includes('SUPERSECRETTOKEN'),
    false,
    'the full launch URL never appears in the rendered tree',
  )

  const failed = render({
    ...base,
    status: 'error',
    error: 'cloudflared is not installed or not on PATH.',
    errorCode: 'PREREQUISITES',
    prereqsOk: false,
    prereqs: [{ id: 'cloudflared', ok: false, message: 'cloudflared is not installed or not on PATH.', hint: 'Install cloudflared.' }],
  })
  assert.ok(collect(failed, (node) => String(node.props.className).includes('ht-banner-error')).length > 0)
  assert.ok(collect(failed, (node) => String(node.props.className).includes('ht-check-bad')).length > 0)
  assert.ok(collect(failed, (node) => String(node.props.className).includes('ht-status-error')).length > 0)
})
