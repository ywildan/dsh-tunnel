/**
 * Strip ANSI escapes from one captured `cloudflared` line.
 * @param line - raw stdout or stderr text.
 * @returns the line without terminal color control sequences.
 */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/**
 * Remove anything shaped like a credential from a line before it reaches the
 * UI, the log file, or the agent.
 *
 * `cloudflared` does not print tunnel secrets during `tunnel run`, but the
 * product requirement is absolute: this plugin must never surface Cloudflare
 * credentials, tunnel secrets, or API tokens. The long-token rule therefore
 * masks UUIDs (including the tunnel id embedded in paths and connection
 * lines), base64 secrets, and JWT-like values, while ordinary prose, hostnames,
 * and ports survive.
 * @param line - one captured log line.
 * @returns the sanitized line.
 */
export function redactSecrets(line: string): string {
  return stripAnsi(line)
    .replace(/((?:token|secret|api[-_]?key|authorization|password)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]')
    .replace(/\s+$/, '')
}