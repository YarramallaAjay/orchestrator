/**
 * Claude Code runtime adapter.
 *
 * Wraps the Claude Agent SDK's query() function into the platform's
 * RuntimeAdapter interface. This is the primary adapter for M1.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import type {
  RuntimeAdapter,
  RuntimeState,
  AdapterConfig,
  ExecutionInput,
  RuntimeEvent,
  RuntimeResult,
  RuntimeMetrics,
} from '../types.js';

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly type = 'claude-code';
  readonly capabilities = ['file-edit', 'shell', 'git', 'search', 'text-generation'];

  private state: RuntimeState = 'idle';
  private config: AdapterConfig | null = null;
  private abortController: AbortController | null = null;

  async initialize(config: AdapterConfig): Promise<void> {
    this.config = config;
    this.state = 'idle';
  }

  async *execute(input: ExecutionInput): AsyncGenerator<RuntimeEvent, void, undefined> {
    if (!this.config) {
      throw new Error('Adapter not initialized. Call initialize() first.');
    }

    this.state = 'running';
    this.abortController = new AbortController();
    const startTime = Date.now();

    // Build clean env
    const env: Record<string, string | undefined> = { ...process.env };
    delete env['CLAUDE_CODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    env['ORCH_AGENT_MODE'] = '1';
    if (this.config.env) {
      Object.assign(env, this.config.env);
    }

    // Build prompt with context
    let fullPrompt = input.prompt;
    if (input.context) {
      fullPrompt = `${input.context}\n\n---\n\n${input.prompt}`;
    }
    if (input.retryFeedback) {
      fullPrompt += `\n\n---\n\n## Previous Attempt Feedback\n\n${input.retryFeedback}`;
    }

    // Build system prompt
    const systemParts: string[] = [];
    if (this.config.systemPrompt) systemParts.push(this.config.systemPrompt);
    if (input.systemPrompt) systemParts.push(input.systemPrompt);

    // Determine permission mode
    const permMode = this.config.permissionMode === 'auto'
      ? 'bypassPermissions' as const
      : (this.config.permissionMode ?? 'default') as 'default' | 'acceptEdits';

    let totalCost = 0;
    let turnsUsed = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCallCount = 0;
    let resultText = '';
    let success = true;
    let errorMsg: string | undefined;
    const filesModified: string[] = [];

    yield {
      type: 'progress',
      message: 'Starting Claude Code execution',
      timestamp: new Date().toISOString(),
    };

    try {
      const q = query({
        prompt: fullPrompt,
        options: {
          cwd: this.config.cwd,
          model: this.config.model ?? 'claude-sonnet-4-6',
          maxTurns: this.config.maxTurns ?? 25,
          maxBudgetUsd: this.config.maxBudgetUsd,
          permissionMode: permMode,
          allowDangerouslySkipPermissions: permMode === 'bypassPermissions',
          allowedTools: this.config.allowedTools ?? [],
          abortController: this.abortController,
          env,
          ...(systemParts.length > 0 ? {
            managedSettings: {
              appendSystemPrompt: systemParts.join('\n\n'),
            } as any,
          } : {}),
        },
      });

      for await (const event of q) {
        switch (event.type) {
          case 'assistant': {
            const content = extractAssistantText(event);
            if (content) {
              yield {
                type: 'output',
                content,
                role: 'assistant',
                timestamp: new Date().toISOString(),
              };
            }

            // Extract tool uses
            const message = (event as any).message;
            if (message?.content && Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === 'tool_use') {
                  toolCallCount++;

                  // Track file modifications
                  if (['Write', 'Edit'].includes(block.name) && block.input?.file_path) {
                    filesModified.push(block.input.file_path);
                  }

                  yield {
                    type: 'tool_use',
                    tool: block.name,
                    input: block.input ?? {},
                    timestamp: new Date().toISOString(),
                  };
                }
              }
            }
            break;
          }

          case 'result': {
            const result = event as any;
            totalCost = result.total_cost_usd ?? 0;
            turnsUsed = result.num_turns ?? 0;

            if (result.subtype === 'success') {
              resultText = result.result ?? '';
            } else {
              success = false;
              errorMsg = result.error ?? result.result ?? 'Unknown error';
            }

            // Extract token usage
            if (result.usage) {
              inputTokens = result.usage.input_tokens ?? 0;
              outputTokens = result.usage.output_tokens ?? 0;
            }

            // Prefer modelUsage for comprehensive accounting
            if (result.modelUsage && typeof result.modelUsage === 'object') {
              let totalIn = 0;
              let totalOut = 0;
              for (const model of Object.values(result.modelUsage) as any[]) {
                totalIn += model.inputTokens ?? 0;
                totalOut += model.outputTokens ?? 0;
              }
              if (totalIn > 0) inputTokens = totalIn;
              if (totalOut > 0) outputTokens = totalOut;
            }
            break;
          }
        }
      }
    } catch (err: any) {
      success = false;
      errorMsg = err.message ?? String(err);

      yield {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
        recoverable: true,
        timestamp: new Date().toISOString(),
      };
    }

    const durationMs = Date.now() - startTime;
    this.state = success ? 'completed' : 'failed';

    const metrics: RuntimeMetrics = {
      durationMs,
      costUsd: totalCost,
      inputTokens,
      outputTokens,
      toolCalls: toolCallCount,
      turns: turnsUsed,
    };

    const result: RuntimeResult = {
      success,
      output: resultText || errorMsg || '',
      filesModified: [...new Set(filesModified)],
      metrics,
    };

    yield {
      type: 'done',
      result,
      timestamp: new Date().toISOString(),
    };
  }

  async cancel(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.state = 'cancelled';
    }
  }

  status(): RuntimeState {
    return this.state;
  }
}

function extractAssistantText(event: any): string {
  const message = event.message;
  if (!message) return '';

  if (message.content && Array.isArray(message.content)) {
    return message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('');
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  return '';
}
