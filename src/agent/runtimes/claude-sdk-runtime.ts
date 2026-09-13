import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig } from '../types.js';
import type { AgentRuntime, AgentMessage, AgentRunResult } from './runtime.js';

/**
 * Agent runtime using the Claude Agent SDK's `query()` function.
 * Runs Claude in-process via the SDK rather than spawning a CLI subprocess.
 */
export class ClaudeSdkRuntime implements AgentRuntime {
  readonly type = 'claude-sdk' as const;
  private activeQueries = new Map<string, AbortController>();

  async *run(params: {
    prompt: string;
    systemPrompt?: string;
    config: AgentConfig;
    cwd: string;
    sessionId?: string;
    signal?: AbortSignal;
    mcpServers?: Record<string, unknown>;
  }): AsyncGenerator<AgentMessage, AgentRunResult, undefined> {
    const abortController = new AbortController();
    const trackingId = params.sessionId ?? `sdk_${Date.now()}`;
    this.activeQueries.set(trackingId, abortController);

    // Forward external abort signal
    if (params.signal) {
      params.signal.addEventListener('abort', () => abortController.abort());
    }

    const messages: AgentMessage[] = [];
    let totalCost = 0;
    let turnsUsed = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCallCount = 0;
    let lastSessionId: string | null = null;
    let resultText = '';
    let success = true;
    let error: string | undefined;

    // Build env without CLAUDE_CODE vars
    const env: Record<string, string | undefined> = { ...process.env };
    delete env['CLAUDE_CODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    // Mark as orchestrator agent subprocess so hooks skip themselves
    env['ORCH_AGENT_MODE'] = '1';
    if (params.config.env) {
      Object.assign(env, params.config.env);
    }

    // Build system prompt as appended instructions
    const systemPromptParts: string[] = [];
    if (params.config.systemPrompt) {
      systemPromptParts.push(params.config.systemPrompt);
    }
    if (params.systemPrompt) {
      systemPromptParts.push(params.systemPrompt);
    }

    // Determine permission mode
    const permissionMode = params.config.permissionMode === 'auto'
      ? 'bypassPermissions' as const
      : (params.config.permissionMode ?? 'default') as 'default' | 'acceptEdits';

    try {
      const q = query({
        prompt: params.prompt,
        options: {
          cwd: params.cwd,
          model: params.config.model ?? 'claude-sonnet-4-6',
          maxTurns: params.config.maxTurns ?? 25,
          maxBudgetUsd: params.config.maxBudgetUsd,
          permissionMode,
          allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
          allowedTools: params.config.allowedTools ?? [],
          abortController,
          env,
          ...(params.mcpServers ? { mcpServers: params.mcpServers as any } : {}),
          ...(params.sessionId ? { resume: params.sessionId } : {}),
          ...(systemPromptParts.length > 0 ? {
            // Use managed settings to inject system prompt
            managedSettings: {
              appendSystemPrompt: systemPromptParts.join('\n\n'),
            } as any,
          } : {}),
        },
      });

      for await (const event of q) {
        switch (event.type) {
          case 'assistant': {
            // Extract text content from the API message
            const content = this.extractAssistantText(event);
            if (content) {
              const msg: AgentMessage = {
                role: 'assistant',
                content,
                timestamp: new Date().toISOString(),
              };

              // Check for tool_use blocks in the message
              const message = (event as any).message;
              if (message?.content && Array.isArray(message.content)) {
                for (const block of message.content) {
                  if (block.type === 'tool_use') {
                    toolCallCount++;
                    const toolMsg: AgentMessage = {
                      role: 'assistant',
                      content: `[Tool: ${block.name}]`,
                      toolUse: { name: block.name, input: block.input ?? {} },
                      timestamp: new Date().toISOString(),
                    };
                    messages.push(toolMsg);
                    yield toolMsg;
                  }
                }
              }

              messages.push(msg);
              yield msg;
            }
            // Capture session ID from the message
            if ((event as any).session_id) {
              lastSessionId = (event as any).session_id;
            }
            break;
          }

          case 'result': {
            const result = event as any;
            totalCost = result.total_cost_usd ?? 0;
            turnsUsed = result.num_turns ?? 0;
            lastSessionId = result.session_id ?? lastSessionId;

            if (result.subtype === 'success') {
              resultText = result.result ?? '';
            } else {
              // Error result
              success = false;
              error = result.error ?? result.result ?? 'Unknown error';
            }

            // Extract tokens from usage (main loop only)
            if (result.usage) {
              inputTokens = result.usage.input_tokens ?? 0;
              outputTokens = result.usage.output_tokens ?? 0;
            }

            // Prefer modelUsage for comprehensive accounting (includes subagents, sidechains)
            if (result.modelUsage && typeof result.modelUsage === 'object') {
              let totalInput = 0;
              let totalOutput = 0;
              for (const model of Object.values(result.modelUsage) as any[]) {
                totalInput += model.inputTokens ?? 0;
                totalOutput += model.outputTokens ?? 0;
              }
              if (totalInput > 0) inputTokens = totalInput;
              if (totalOutput > 0) outputTokens = totalOutput;
            }
            break;
          }

          default:
            // Ignore other event types (status, hook events, etc.)
            break;
        }
      }
    } catch (err: any) {
      success = false;
      error = err.message ?? String(err);
    } finally {
      this.activeQueries.delete(trackingId);
    }

    // If no messages were yielded but we got a result text, add it
    if (resultText && messages.length === 0) {
      const msg: AgentMessage = {
        role: 'assistant',
        content: resultText,
        timestamp: new Date().toISOString(),
      };
      messages.push(msg);
      yield msg;
    }

    return {
      success,
      messages,
      outputArtifacts: {},
      totalCostUsd: totalCost,
      turnsUsed,
      inputTokens,
      outputTokens,
      toolCalls: toolCallCount,
      sessionId: lastSessionId,
      error,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // The SDK is available if we can import it (which we already did)
      return typeof query === 'function';
    } catch {
      return false;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const controller = this.activeQueries.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  private extractAssistantText(event: any): string {
    const message = event.message;
    if (!message) return '';

    // API message has content array
    if (message.content && Array.isArray(message.content)) {
      const textParts = message.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text);
      return textParts.join('');
    }

    if (typeof message.content === 'string') {
      return message.content;
    }

    return '';
  }
}
