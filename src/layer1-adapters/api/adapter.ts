/**
 * Generic API runtime adapter.
 *
 * Calls any LLM API via HTTP (OpenAI, Anthropic, Groq, local LLMs, etc.).
 * Configurable via baseUrl, apiKey, model, and request/response transforms.
 *
 * Supports both OpenAI-compatible and Anthropic-compatible APIs out of the box.
 */

import type {
  RuntimeAdapter,
  RuntimeState,
  AdapterConfig,
  ExecutionInput,
  RuntimeEvent,
  RuntimeResult,
} from '../types.js';

// ─── API Adapter Config ─────────────────────────────────────────────────────

export interface ApiAdapterConfig {
  /** Base URL for the API (e.g., https://api.openai.com/v1). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey?: string;
  /** API format: 'openai' or 'anthropic'. */
  format?: 'openai' | 'anthropic';
  /** Default model to use. */
  model?: string;
  /** Default max tokens for responses. */
  maxTokens?: number;
  /** Default temperature. */
  temperature?: number;
  /** Custom headers to include. */
  headers?: Record<string, string>;
}

// ─── API Adapter ────────────────────────────────────────────────────────────

export class ApiAdapter implements RuntimeAdapter {
  readonly type = 'api';
  readonly capabilities = ['text-generation', 'reasoning'];

  private state: RuntimeState = 'idle';
  private config: ApiAdapterConfig | null = null;
  private adapterConfig: AdapterConfig | null = null;
  private abortController: AbortController | null = null;

  async initialize(config: AdapterConfig): Promise<void> {
    this.adapterConfig = config;
    this.config = (config.extra ?? {}) as unknown as ApiAdapterConfig;

    if (!this.config.baseUrl) {
      throw new Error('ApiAdapter requires a baseUrl in config');
    }

    this.state = 'idle';
  }

  async *execute(input: ExecutionInput): AsyncGenerator<RuntimeEvent, void, undefined> {
    if (!this.config) throw new Error('Adapter not initialized');

    this.state = 'running';
    this.abortController = new AbortController();
    const startTime = Date.now();

    yield {
      type: 'progress',
      message: 'Sending request to API...',
      percent: 10,
      timestamp: new Date().toISOString(),
    };

    try {
      const format = this.config.format ?? 'openai';
      const model = this.adapterConfig?.model ?? this.config.model ?? 'gpt-4';
      const maxTokens = this.config.maxTokens ?? 4096;

      const { url, body, headers } = this.buildRequest(format, model, maxTokens, input);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed (${response.status}): ${errorText}`);
      }

      const data = await response.json() as Record<string, any>;
      const output = this.extractOutput(format, data);
      const usage = this.extractUsage(format, data);

      yield {
        type: 'output',
        content: output,
        role: 'assistant',
        timestamp: new Date().toISOString(),
      };

      const durationMs = Date.now() - startTime;
      this.state = 'completed';

      const result: RuntimeResult = {
        success: true,
        output,
        metrics: {
          durationMs,
          costUsd: 0, // Could be computed from model pricing
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          toolCalls: 0,
          turns: 1,
        },
      };

      yield { type: 'done', result, timestamp: new Date().toISOString() };
    } catch (err: any) {
      this.state = 'failed';
      const durationMs = Date.now() - startTime;

      if (err.name === 'AbortError') {
        yield {
          type: 'done',
          result: {
            success: false,
            output: 'Request cancelled',
            metrics: { durationMs, costUsd: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, turns: 0 },
          },
          timestamp: new Date().toISOString(),
        };
      } else {
        yield {
          type: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
          recoverable: true,
          timestamp: new Date().toISOString(),
        };

        yield {
          type: 'done',
          result: {
            success: false,
            output: err.message ?? String(err),
            metrics: { durationMs, costUsd: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, turns: 0 },
          },
          timestamp: new Date().toISOString(),
        };
      }
    } finally {
      this.abortController = null;
    }
  }

  async cancel(): Promise<void> {
    this.abortController?.abort();
    this.state = 'cancelled';
  }

  status(): RuntimeState {
    return this.state;
  }

  // ─── Request Building ───────────────────────────────────────────────────

  private buildRequest(
    format: 'openai' | 'anthropic',
    model: string,
    maxTokens: number,
    input: ExecutionInput,
  ): { url: string; body: Record<string, any>; headers: Record<string, string> } {
    const baseUrl = this.config!.baseUrl.replace(/\/$/, '');
    const apiKey = this.config!.apiKey ?? '';

    const messages = this.buildMessages(input);

    if (format === 'anthropic') {
      return {
        url: `${baseUrl}/messages`,
        body: {
          model,
          max_tokens: maxTokens,
          messages,
          ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
          ...(this.config!.temperature !== undefined ? { temperature: this.config!.temperature } : {}),
        },
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...this.config!.headers,
        },
      };
    }

    // OpenAI-compatible format (default)
    const fullMessages = input.systemPrompt
      ? [{ role: 'system', content: input.systemPrompt }, ...messages]
      : messages;

    return {
      url: `${baseUrl}/chat/completions`,
      body: {
        model,
        messages: fullMessages,
        max_tokens: maxTokens,
        ...(this.config!.temperature !== undefined ? { temperature: this.config!.temperature } : {}),
      },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...this.config!.headers,
      },
    };
  }

  private buildMessages(input: ExecutionInput): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    if (input.context) {
      messages.push({ role: 'user', content: `Context:\n${input.context}` });
      messages.push({ role: 'assistant', content: 'I understand the context. What would you like me to do?' });
    }

    if (input.retryFeedback) {
      messages.push({ role: 'user', content: input.retryFeedback });
    }

    messages.push({ role: 'user', content: input.prompt });
    return messages;
  }

  // ─── Response Parsing ───────────────────────────────────────────────────

  private extractOutput(format: 'openai' | 'anthropic', data: Record<string, any>): string {
    if (format === 'anthropic') {
      const content = data.content;
      if (Array.isArray(content)) {
        return content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
      }
      return String(content ?? '');
    }

    // OpenAI format
    const choices = data.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      return choices[0].message?.content ?? '';
    }
    return '';
  }

  private extractUsage(
    format: 'openai' | 'anthropic',
    data: Record<string, any>,
  ): { inputTokens: number; outputTokens: number } {
    const usage = data.usage;
    if (!usage) return { inputTokens: 0, outputTokens: 0 };

    if (format === 'anthropic') {
      return {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      };
    }

    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  }
}
