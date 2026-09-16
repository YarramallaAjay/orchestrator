import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Check if a file path is executable.
 */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the `claude` CLI binary using multiple strategies:
 * 1. Local node_modules/.bin/claude
 * 2. System `which`/`where` lookup
 * 3. Common global install paths
 * 4. Bare 'claude' fallback (let PATH resolve)
 */
export function findClaudeBinary(): string {
  // Strategy 1: Local node_modules/.bin/claude
  const localPath = resolve('node_modules', '.bin', 'claude');
  if (isExecutable(localPath)) return localPath;

  // Strategy 2: which/where to find globally installed claude
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['claude'], { encoding: 'utf-8' }).trim();
    if (result) return result.split('\n')[0]!;
  } catch { /* not found via which */ }

  // Strategy 3: Common global install paths
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const globalPaths = [
    resolve(home, '.npm', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of globalPaths) {
    if (isExecutable(p)) return p;
  }

  // Fallback: bare 'claude', let PATH resolve it
  return 'claude';
}

/**
 * Build a sanitized environment for Claude subprocesses.
 * Strips env vars that block Claude CLI from running as a subprocess.
 */
export function buildClaudeEnv(
  configEnv?: Record<string, string>,
  options?: { agentMode?: boolean; wrapMode?: boolean },
): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  // Strip env vars that block Claude CLI from running as a subprocess
  // Claude Code sets both CLAUDECODE (nesting guard) and CLAUDE_CODE_ENTRYPOINT
  delete env['CLAUDECODE'];
  delete env['CLAUDE_CODE'];
  delete env['CLAUDE_CODE_ENTRYPOINT'];

  if (options?.agentMode) {
    env['ORCH_AGENT_MODE'] = '1';
  }
  if (options?.wrapMode) {
    env['ORCH_WRAP_MODE'] = '1';
  }

  // Apply user-configured env overrides
  if (configEnv) {
    Object.assign(env, configEnv);
  }
  return env;
}
