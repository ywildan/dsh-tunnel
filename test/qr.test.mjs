import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

const require = createRequire(import.meta.url)

/**
 * Load the plugin's compiled QR encoder from the build output. The build emits
 * CommonJS while the package is `type: module`, so evaluate it the same way the
 * Client bundle loader does.
 * @returns the module exports.
 */
function loadEncoder() {
  const source = readFileSync(new URL('../.build/client/qrcode.js', import.meta.url), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require, console }, { filename: 'qrcode.js' })
  return module.exports
}

/**
 * Render a matrix into an RGBA buffer with a quiet zone and a scale factor so a
 * real decoder can read it.
 * @param matrix - QR matrix.
 * @param scale - pixels per module.
 * @returns RGBA pixels and the image width.
 */
function toRgba(matrix, scale = 4) {
  const quiet = 4
  const modules = matrix.size + quiet * 2
  const width = modules * scale
  const data = new Uint8ClampedArray(width * width * 4).fill(255)
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (!matrix.dark(row, col)) continue
      const x0 = (col + quiet) * scale
      const y0 = (row + quiet) * scale
      for (let y = y0; y < y0 + scale; y += 1) {
        for (let x = x0; x < x0 + scale; x += 1) {
          const offset = (y * width + x) * 4
          data[offset] = 0
          data[offset + 1] = 0
          data[offset + 2] = 0
        }
      }
    }
  }
  return { data, width }
}

test('the vendored encoder reproduces the reference library exactly', () => {
  const { createQrMatrix } = loadEncoder()
  const reference = require('qrcode-generator')
  reference.stringToBytes = reference.stringToBytesFuncs['UTF-8']

  const payloads = [
    'https://helux.web.id/?token=A',
    'https://helux.web.id/?token=7Hg3kLm2QpR9sT4vW6xY8zA1bC5dE0fJ2nM4oP6rS8t',
    'https://helux.web.id/',
  ]
  for (const payload of payloads) {
    const mine = createQrMatrix(payload)
    const qr = reference(0, 'M')
    qr.addData(payload, 'Byte')
    qr.make()
    assert.equal(mine.size, qr.getModuleCount(), `module count for ${payload.slice(0, 40)}`)
    for (let row = 0; row < mine.size; row += 1) {
      for (let col = 0; col < mine.size; col += 1) {
        assert.equal(mine.dark(row, col), qr.isDark(row, col) === true, `module ${row},${col} for ${payload.slice(0, 40)}`)
      }
    }
  }
})

test('the generated QR decodes back to the exact launch URL', () => {
  const { createQrMatrix } = loadEncoder()
  const jsQR = require('jsqr')
  const token = '7Hg3kLm2QpR9sT4vW6xY8zA1bC5dE0fJ2nM4oP6rS8t'
  const url = `https://helux.web.id/?token=${token}`

  const matrix = createQrMatrix(url)
  const { data, width } = toRgba(matrix)
  const decoded = jsQR(data, width, width)
  assert.ok(decoded, 'the decoder must find a QR code')
  assert.equal(decoded.data, url)

  // The token must survive byte-for-byte, including base64url characters.
  assert.equal(new URL(decoded.data).searchParams.get('token'), token)
})

test('the encoder picks a compact version for a real launch URL', () => {
  const { createQrMatrix } = loadEncoder()
  const matrix = createQrMatrix(`https://helux.web.id/?token=${'a'.repeat(43)}`)
  // 43-char base64url token + prefix is 74 bytes; version 5 or 6 fits at ECC M.
  assert.ok(matrix.size >= 21 && matrix.size <= 57, `unexpected module count ${matrix.size}`)
  assert.equal((matrix.size - 17) % 4, 0, 'module count follows the QR version formula')
})
