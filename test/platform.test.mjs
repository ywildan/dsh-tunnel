import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  binDirectories,
  collapseHome,
  executableExtensions,
  pathDirectories,
  terminationStrategy,
} from '../lib/host/platform.js'

// Every case below is evaluated on whatever OS runs the suite, because the
// platform is a parameter. That is the point: the Windows branch would
// otherwise only be exercised on a Windows machine, which is how a
// `.cmd`-cannot-be-spawned bug reached review.

test('Windows resolution only accepts extensions Node can execute directly', () => {
  const extensions = executableExtensions('win32', '.COM;.EXE;.BAT;.CMD;.VBS')
  assert.deepEqual(extensions, ['.com', '.exe', ''])
  assert.ok(!extensions.includes('.bat'), 'a .bat cannot be spawned without a shell')
  assert.ok(!extensions.includes('.cmd'), 'a .cmd cannot be spawned without a shell')
})

test('Windows resolution works without PATHEXT set', () => {
  assert.deepEqual(executableExtensions('win32', undefined), ['.exe', '.com', ''])
  assert.deepEqual(executableExtensions('win32', ''), ['.exe', '.com', ''])
})

test('POSIX resolution looks only for the bare binary name', () => {
  assert.deepEqual(executableExtensions('linux', '.exe'), [''])
  assert.deepEqual(executableExtensions('darwin', undefined), [''])
})

test('Windows install directories cover the documented installers', () => {
  const dirs = binDirectories(
    'win32',
    {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    },
    'C:\\Users\\me',
  )
  const joined = dirs.join('|')
  assert.match(joined, /cloudflared/, 'the official installer target is searched')
  assert.match(joined, /WinGet[\\/]Links/, 'winget links are searched')
  assert.match(joined, /scoop[\\/]shims/, 'scoop shims are searched')
  assert.ok(!dirs.some((dir) => dir.includes('undefined')), 'a missing env var must not leak into a path')
})

test('Windows install directories survive a missing LOCALAPPDATA', () => {
  const dirs = binDirectories('win32', { ProgramFiles: 'D:\\Apps' }, '')
  assert.ok(dirs.length >= 2)
  assert.ok(!dirs.some((dir) => dir.includes('undefined')))
})

test('POSIX install directories are the usual bin paths', () => {
  const dirs = binDirectories('linux', {}, '/home/me')
  assert.deepEqual(dirs, ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/home/me/.local/bin'])
})

test('PATH parsing handles quoted Windows entries and empty segments', () => {
  const parsed = pathDirectories('win32', '"C:\\Program Files\\cloudflared";C:\\bin;;  ')
  assert.deepEqual(parsed, ['C:\\Program Files\\cloudflared', 'C:\\bin'])
})

test('PATH parsing uses the platform separator', () => {
  assert.deepEqual(pathDirectories('linux', '/usr/bin:/usr/local/bin'), ['/usr/bin', '/usr/local/bin'])
  // A POSIX-style value on Windows is one directory, not two.
  assert.deepEqual(pathDirectories('win32', 'C:\\bin'), ['C:\\bin'])
})

test('Windows termination goes through taskkill, POSIX through signals', () => {
  assert.deepEqual(terminationStrategy('win32'), { graceful: 'taskkill', forced: 'taskkill' })
  assert.deepEqual(terminationStrategy('linux'), { graceful: 'signal', forced: 'signal' })
  assert.deepEqual(terminationStrategy('darwin'), { graceful: 'signal', forced: 'signal' })
})

test('home collapsing uses the platform separator', () => {
  assert.equal(collapseHome('C:\\Users\\me\\.cloudflared\\config.yml', 'C:\\Users\\me', '\\'), '~\\.cloudflared\\config.yml')
  assert.equal(collapseHome('/home/me/.cloudflared/config.yml', '/home/me', '/'), '~/.cloudflared/config.yml')
  assert.equal(collapseHome('/home/me', '/home/me', '/'), '~')
  assert.equal(collapseHome('/elsewhere/file', '/home/me', '/'), '/elsewhere/file')
})
