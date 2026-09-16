import { spawn, type ChildProcess } from 'node:child_process';
import { findClaudeBinary, buildClaudeEnv } from '../../util/claude-binary.js';
import type { HarnessAdapter, HarnessConfig, HarnessProcess, HarnessSessionResult } from '../types.js';

/**
 * Adapter that wraps Claude Code as an interactive subprocess.
 * Spawns with stdio: 'inherit' so the user gets the full native TUI experience.
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly type = 'claude-code' as const;
  private activeProcess: ChildProcess | null = null;
  private startTime = 0;

  async isAvailable(): Promise<boolean> {
    try {
      const binary = findClaudeBinary();
      // Check if the binary is 'claude' (bare fallback) — can't verify without running
      if (binary === 'claude') {
        const { execFileSync } = await import('node:child_process');
        execFileSync('which', ['claude'], { encoding: 'utf-8' });
        return true;
      }
      return true;
    } catch {
      return false;
    }
  }

  async start(config: HarnessConfig): Promise<HarnessProcess> {
    const binary = findClaudeBinary();
    const args = this.buildArgs(config);
    const env = buildClaudeEnv(config.env, { wrapMode: true });

    this.startTime = Date.now();

    const proc = spawn(binary, args, {
      cwd: config.cwd,
      env,
      stdio: 'inherit',
    });

    this.activeProcess = proc;

    const exitPromise = new Promise<HarnessSessionResult>((resolve) => {
      proc.on('exit', (code) => {
        this.activeProcess = null;
        resolve({
          exitCode: code ?? 1,
          durationMs: Date.now() - this.startTime,
          sessionId: null, // harvested post-exit by gateway
        });
      });

      proc.on('error', (err) => {
        this.activeProcess = null;
        resolve({
          exitCode: 1,
          durationMs: Date.now() - this.startTime,
          sessionId: null,
        });
      });
    });

    return {
      pid: proc.pid!,
      process: proc,
      exitPromise,
    };
  }

  async stop(): Promise<void> {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      // Give it 5s to exit gracefully before SIGKILL
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.activeProcess) {
            this.activeProcess.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.activeProcess!.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }

  private buildArgs(config: HarnessConfig): string[] {
    const args: string[] = [];

    if (config.model) {
      args.push('--model', config.model);
    }

    if (config.mcpConfigPath) {
      args.push('--mcp-config', config.mcpConfigPath);
    }

    if (config.resumeSession) {
      args.push('--resume', config.resumeSession);
    }

    if (config.additionalArgs?.length) {
      args.push(...config.additionalArgs);
    }

    return args;
  }
}
