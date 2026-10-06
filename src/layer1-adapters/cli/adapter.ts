/**
 * CLI runtime adapter.
 *
 * Runs shell commands as a "runtime". Useful for Docker, kubectl, git,
 * npm, build tools, deployment scripts, etc.
 *
 * The prompt is used as the command to execute (or as input to a
 * configured command template).
 */

import { spawn } from 'node:child_process';
import type {
  RuntimeAdapter,
  RuntimeState,
  AdapterConfig,
  ExecutionInput,
  RuntimeEvent,
} from '../types.js';

// ─── CLI Adapter Config ─────────────────────────────────────────────────────

export interface CliAdapterConfig {
  /** Shell to use (default: /bin/sh). */
  shell?: string;
  /** Command template. Use {{prompt}} for the task prompt. If not set, the prompt IS the command. */
  commandTemplate?: string;
  /** Timeout in milliseconds (default: 300000 = 5 min). */
  timeoutMs?: number;
  /** Additional environment variables. */
  env?: Record<string, string>;
}

// ─── CLI Adapter ────────────────────────────────────────────────────────────

export class CliAdapter implements RuntimeAdapter {
  readonly type = 'cli';
  readonly capabilities = ['shell', 'file-system', 'deployment'];

  private state: RuntimeState = 'idle';
  private config: CliAdapterConfig = {};
  private cwd = '.';
  private childProcess: ReturnType<typeof spawn> | null = null;

  async initialize(config: AdapterConfig): Promise<void> {
    this.cwd = config.cwd;
    this.config = (config.extra ?? {}) as CliAdapterConfig;
    this.state = 'idle';
  }

  async *execute(input: ExecutionInput): AsyncGenerator<RuntimeEvent, void, undefined> {
    this.state = 'running';
    const startTime = Date.now();

    // Build the command
    let command: string;
    if (this.config.commandTemplate) {
      command = this.config.commandTemplate.replace(/\{\{prompt\}\}/g, input.prompt);
    } else {
      command = input.prompt;
    }

    yield {
      type: 'progress',
      message: `Executing: ${command.substring(0, 100)}${command.length > 100 ? '...' : ''}`,
      percent: 10,
      timestamp: new Date().toISOString(),
    };

    try {
      const { stdout, stderr, exitCode } = await this.runCommand(command);
      const durationMs = Date.now() - startTime;
      const success = exitCode === 0;

      if (stdout) {
        yield {
          type: 'output',
          content: stdout,
          role: 'assistant',
          timestamp: new Date().toISOString(),
        };
      }

      if (stderr && !success) {
        yield {
          type: 'error',
          error: new Error(stderr),
          recoverable: true,
          timestamp: new Date().toISOString(),
        };
      }

      this.state = success ? 'completed' : 'failed';
      const output = success
        ? stdout || '(command completed successfully with no output)'
        : `Exit code ${exitCode}: ${stderr || stdout}`;

      yield {
        type: 'done',
        result: {
          success,
          output,
          metrics: {
            durationMs,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: 1,
            turns: 1,
          },
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      this.state = 'failed';
      const durationMs = Date.now() - startTime;

      yield {
        type: 'done',
        result: {
          success: false,
          output: err.message ?? String(err),
          metrics: {
            durationMs,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: 1,
            turns: 1,
          },
        },
        timestamp: new Date().toISOString(),
      };
    } finally {
      this.childProcess = null;
    }
  }

  async cancel(): Promise<void> {
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
    this.state = 'cancelled';
  }

  status(): RuntimeState {
    return this.state;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const shell = this.config.shell ?? '/bin/sh';
      const timeoutMs = this.config.timeoutMs ?? 300_000;

      const env = {
        ...process.env,
        ...this.config.env,
      };

      const child = spawn(shell, ['-c', command], {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.childProcess = child;

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
