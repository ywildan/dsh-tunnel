#!/usr/bin/env node
/**
 * Fail when the committed build output does not match the committed sources.
 *
 * `lib/` and `client.js` are committed on purpose: `dsh plugin add
 * github:ywildan/dsh-tunnel` installs the repository as-is and never runs a
 * build, so a stale artifact silently ships old behaviour with no error. That
 * is the worst kind of bug to receive, because nothing in the install path can
 * detect it.
 *
 * This script rebuilds and then asks git whether anything changed. Run it
 * after committing; it is the same check the CI workflow runs.
 */
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Build artifacts that must stay in lockstep with `src/`. */
const TRACKED_OUTPUT = ['lib', 'client.js']

/**
 * Run a command, returning its stdout.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @returns {string} trimmed stdout.
 */
function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim()
}

/**
 * Whether this directory is a git checkout.
 * @returns {boolean} true when git can describe the repository.
 */
function inGitWorkTree() {
  try {
    run('git', ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

if (!inGitWorkTree()) {
  console.log('check-build: not a git checkout, nothing to compare; skipping')
  process.exit(0)
}

console.log('check-build: rebuilding from src/ ...')
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' })

const dirty = run('git', ['status', '--porcelain', '--', ...TRACKED_OUTPUT])
  .split('\n')
  .filter((line) => line.length > 0)

if (dirty.length === 0) {
  console.log('check-build: committed output matches src/')
  process.exit(0)
}

console.error('')
console.error('check-build: FAILED - the committed build output is stale.')
console.error('')
console.error('These paths changed when rebuilt from src/:')
for (const line of dirty) console.error(`  ${line}`)
console.error('')
console.error('Anyone installing from git receives lib/ and client.js as committed, and')
console.error('the install path never rebuilds them, so what they get would not match src/.')
console.error('')
console.error('Fix:')
console.error('  npm run build && git add lib client.js && git commit')
process.exit(1)
