import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentConfig } from '../types.js';
import type { AgentRuntime, AgentMessage, AgentRunResult } from './runtime.js';

/**
 * Agent runtime that spawns `claude` CLI processes.
 * Uses `claude -p <prompt> --output-format stream-json` for streaming output.
 *
 * This is the primary runtime for isolated agent execution.
 */
export class ClaudeCliRuntime implements AgentRuntime {
  readonly type = 'claude-cli' as const;
  private processes = new Map<string, ChildProcess>();

  async *run(params: {
    prompt: string;
    systemPrompt?: string;
    config: AgentConfig;
    cwd: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<AgentMessage, AgentRunResult, undefined> {
    const args = this.buildArgs(params);
    const claudePath = this.findClaudeBinary();

    const proc = spawn(claudePath, args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const trackingId = params.sessionId ?? `cli_${Date.now()}`;
    this.processes.set(trackingId, proc);

    const messages: AgentMessage[] = [];
    let totalCost = 0;
    let turnsUsed = 0;
    let lastSessionId: string | null = null;
    let buffer = '';

    // Handle abort signal
    if (params.signal) {
      params.signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
      });
    }

    try {
      // Stream stdout line by line, parsing JSON events
      for await (const chunk of proc.stdout!) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const msg = this.parseEvent(event);
            if (msg) {
              messages.push(msg);
              yield msg;
            }
            // Extract metadata from events
            if (event.type === 'result') {
              totalCost = event.cost_usd ?? 0;
              turnsUsed = event.num_turns ?? 0;
              lastSessionId = event.session_id ?? null;
            }
          } catch {
            // Not JSON or unknown format, skip
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          const msg = this.parseEvent(event);
          if (msg) {
            messages.push(msg);
            yield msg;
          }
          if (event.type === 'result') {
            totalCost = event.cost_usd ?? 0;
            turnsUsed = event.num_turns ?? 0;
            lastSessionId = event.session_id ?? null;
          }
        } catch {
          // If the entire output wasn't JSON (plain text mode), wrap it
          if (buffer.trim()) {
            const msg: AgentMessage = {
              role: 'assistant',
              content: buffer.trim(),
              timestamp: new Date().toISOString(),
            };
            messages.push(msg);
            yield msg;
          }
        }
      }
    } finally {
      this.processes.delete(trackingId);
    }

    // Wait for process to exit
    const exitCode = await new Promise<number>((res) => {
      if (proc.exitCode !== null) {
        res(proc.exitCode);
      } else {
        proc.on('exit', (code) => res(code ?? 1));
      }
    });

    return {
      success: exitCode === 0,
      messages,
      outputArtifacts: {},
      totalCostUsd: totalCost,
      turnsUsed,
      sessionId: lastSessionId,
      error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const proc = spawn(this.findClaudeBinary(), ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return new Promise((resolve) => {
        proc.on('exit', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
      });
    } catch {
      return false;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
    }
  }

  private findClaudeBinary(): string {
    // Try the locally installed claude from node_modules
    const localPath = resolve('node_modules', '.bin', 'claude');
    return localPath;
  }

  private buildArgs(params: {
    prompt: string;
    systemPrompt?: string;
    config: AgentConfig;
    sessionId?: string;
  }): string[] {
    const args: string[] = [
      '-p', params.prompt,
      '--output-format', 'stream-json',
    ];

    if (params.config.model) {
      args.push('--model', params.config.model);
    }

    if (params.config.maxTurns) {
      args.push('--max-turns', String(params.config.maxTurns));
    }

    if (params.systemPrompt) {
      args.push('--append-system-prompt', params.systemPrompt);
    }

    if (params.config.permissionMode === 'auto') {
      args.push('--dangerously-skip-permissions');
    }

    if (params.config.allowedTools?.length) {
      for (const tool of params.config.allowedTools) {
        args.push('--allowedTools', tool);
      }
    }

    if (params.sessionId) {
      args.push('--resume', params.sessionId);
    }

    return args;
  }

  private parseEvent(event: any): AgentMessage | null {
    if (!event || typeof event !== 'object') return null;

    // Handle different Claude CLI stream-json event types
    switch (event.type) {
      case 'assistant': {
        const content = typeof event.message === 'string'
          ? event.message
          : event.message?.content
            ? this.extractTextContent(event.message.content)
            : JSON.stringify(event.message);
        return {
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        };
      }
      case 'tool_use': {
        return {
          role: 'assistant',
          content: `[Tool: ${event.tool ?? 'unknown'}]`,
          toolUse: {
            name: event.tool ?? event.name ?? 'unknown',
            input: event.input ?? {},
          },
          timestamp: new Date().toISOString(),
        };
      }
      case 'tool_result': {
        return {
          role: 'assistant',
          content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output),
          toolResult: {
            toolUseId: event.tool_use_id ?? '',
            output: typeof event.output === 'string' ? event.output : JSON.stringify(event.output),
            isError: event.is_error ?? false,
          },
          timestamp: new Date().toISOString(),
        };
      }
      default:
        return null;
    }
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('');
    }
    return JSON.stringify(content);
  }
}
