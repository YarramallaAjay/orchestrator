import type { AgentConfig } from '../types.js';
import type { AgentRuntime, AgentMessage, AgentRunResult } from './runtime.js';
import { logger } from '../../util/logger.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
}

/**
 * Direct Anthropic Messages API runtime.
 * Calls the API directly without using the Claude CLI.
 * Requires ANTHROPIC_API_KEY environment variable.
 */
export class ApiRuntime implements AgentRuntime {
  readonly type = 'api' as const;
  private activeRequests = new Map<string, AbortController>();

  async *run(params: {
    prompt: string;
    systemPrompt?: string;
    config: AgentConfig;
    cwd: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<AgentMessage, AgentRunResult, undefined> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for API runtime');
    }

    const model = params.config.model ?? 'claude-sonnet-4-6';
    const maxTokens = 8192;
    const abortController = new AbortController();
    const sessionId = params.sessionId ?? `api_${Date.now()}`;

    this.activeRequests.set(sessionId, abortController);

    if (params.signal) {
      params.signal.addEventListener('abort', () => abortController.abort());
    }

    const messages: AgentMessage[] = [];
    let totalCost = 0;
    let turnsUsed = 0;

    const conversationMessages: AnthropicMessage[] = [
      { role: 'user', content: params.prompt },
    ];

    try {
      // Simple single-turn execution (multi-turn with tools would require tool definitions)
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: params.systemPrompt,
          messages: conversationMessages,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`API request failed (${response.status}): ${errorBody}`);
      }

      const result = await response.json() as any;
      turnsUsed = 1;

      // Calculate cost (approximate)
      const inputTokens = result.usage?.input_tokens ?? 0;
      const outputTokens = result.usage?.output_tokens ?? 0;
      totalCost = (inputTokens * 0.003 + outputTokens * 0.015) / 1000;

      // Extract text content
      const contentBlocks = result.content ?? [];
      for (const block of contentBlocks) {
        if (block.type === 'text') {
          const msg: AgentMessage = {
            role: 'assistant',
            content: block.text,
            costUsd: totalCost,
            timestamp: new Date().toISOString(),
          };
          messages.push(msg);
          yield msg;
        }
      }
    } finally {
      this.activeRequests.delete(sessionId);
    }

    return {
      success: true,
      messages,
      outputArtifacts: {},
      totalCostUsd: totalCost,
      turnsUsed,
      sessionId,
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  async interrupt(sessionId: string): Promise<void> {
    const controller = this.activeRequests.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }
}
