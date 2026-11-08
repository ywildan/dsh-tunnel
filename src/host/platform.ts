import { join, sep } from 'node:path'

/**
 * Platform-specific rules the tunnel needs, kept pure so both branches are
 * testable from one operating system.
 *
 * Every function takes the platform explicitly instead of reading
 * `process.platform`. Windows behavior is otherwise only exercised by whoever
 * happens to own a Windows machine, which is how the original
 * `.cmd`-cannot-be-spawned bug survived review.
 */

/**
 * Extensions to try when resolving `cloudflared` on Windows.
 *
 * Only real executables are accepted. `.cmd` and `.bat` are deliberately
 * excluded: `child_process.spawn` cannot start a batch file without a shell, so
 * resolving one would turn "cloudflared is missing" into an opaque EINVAL at
 * start time. `PATHEXT` is honoured so a custom install still resolves, but the
 * extension must be one Node can execute directly.
 * @param platform - platform to answer for.
 * @param pathext - `PATHEXT` value, if set.
 * @returns extensions including the leading dot, ending with the bare name.
 */
export function executableExtensions(platform: NodeJS.Platform, pathext?: string): string[] {
  if (platform !== 'win32') return ['']
  const runnable = new Set(['.exe', '.com'])
  const fromEnv = (pathext ?? '')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => runnable.has(entry))
  return [...new Set([...fromEnv, '.exe', '.com', ''])]
}

/**
 * Directories `cloudflared` is normally installed into.
 *
 * These are fallbacks for when DSH was launched from a context whose PATH does
 * not include the installer's target directory - common on Windows, where a
 * service or a GUI-launched process inherits a minimal PATH.
 * @param platform - platform to answer for.
 * @param env - environment to read install locations from.
 * @param home - user home directory.
 * @returns absolute candidate directories, most likely first.
 */
export function binDirectories(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  if (platform !== 'win32') {
    return ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', join(home, '.local', 'bin')]
  }
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env['LOCALAPPDATA']
  const candidates = [
    join(programFiles, 'cloudflared'),
    join(programFiles, 'Cloudflare', 'cloudflared'),
    join(programFilesX86, 'cloudflared'),
  ]
  if (localAppData !== undefined && localAppData.length > 0) {
    // winget installs portable packages under WinGet\Packages and links them
    // into WinGet\Links; the Scoop shim lives in ~\scoop\shims.
    candidates.push(join(localAppData, 'Microsoft', 'WinGet', 'Links'))
    candidates.push(join(localAppData, 'Microsoft', 'WindowsApps'))
  }
  if (home.length > 0) candidates.push(join(home, 'scoop', 'shims'))
  return candidates
}

/**
 * Split a PATH value into usable directory entries.
 *
 * Windows PATH entries are quoted when the directory contains a space, and an
 * empty entry means "current directory" on POSIX - never what we want when
 * looking for an executable.
 * @param platform - platform to answer for.
 * @param pathValue - raw PATH value.
 * @returns unquoted, non-empty directories.
 */
export function pathDirectories(platform: NodeJS.Platform, pathValue: string | undefined): string[] {
  const separator = platform === 'win32' ? ';' : ':'
  return (pathValue ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .map((entry) => (entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry))
    .filter((entry) => entry.length > 0)
}

/**
 * How to ask a child process to stop, and how to force it.
 *
 * Windows has no signals: Node maps every `kill()` to `TerminateProcess`, so
 * there is no graceful path and the child's tree must be terminated explicitly
 * with `taskkill /T`, or a wrapper's grandchild keeps the tunnel open while the
 * plugin reports success.
 * @param platform - platform to answer for.
 * @returns the graceful and forced strategies.
 */
export function terminationStrategy(platform: NodeJS.Platform): {
  graceful: 'taskkill' | 'signal'
  forced: 'taskkill' | 'signal'
} {
  return platform === 'win32'
    ? { graceful: 'taskkill', forced: 'taskkill' }
    : { graceful: 'signal', forced: 'signal' }
}

/**
 * Collapse a home directory to `~` for display.
 * @param path - absolute path.
 * @param home - user home directory.
 * @param separator - platform path separator.
 * @returns display-safe path text.
 */
export function collapseHome(path: string, home: string, separator: string = sep): string {
  if (path === home) return '~'
  const prefix = home.endsWith(separator) ? home : `${home}${separator}`
  return path.startsWith(prefix) ? `~${separator}${path.slice(prefix.length)}` : path
}
