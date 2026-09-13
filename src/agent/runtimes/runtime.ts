import type { AgentConfig } from '../types.js';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolUse?: { name: string; input: Record<string, unknown> };
  toolResult?: { toolUseId: string; output: string; isError: boolean };
  costUsd?: number;
  timestamp: string;
}

export interface AgentRunResult {
  success: boolean;
  messages: AgentMessage[];
  outputArtifacts: Record<string, unknown>;
  totalCostUsd: number;
  turnsUsed: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  sessionId: string | null;
  error?: string;
}

/**
 * The core abstraction for agent execution backends.
 * All backends (Claude SDK, Claude CLI subprocess, direct API) implement this interface.
 *
 * The run method returns an AsyncGenerator that yields messages as they arrive,
 * enabling streaming to the event bus and early termination via return().
 */
export interface AgentRuntime {
  readonly type: 'claude-sdk' | 'claude-cli' | 'api';

  /**
   * Execute a prompt against the agent, yielding messages as they arrive.
   * The return value of the generator is the final AgentRunResult.
   */
  run(params: {
    prompt: string;
    systemPrompt?: string;
    config: AgentConfig;
    cwd: string;
    sessionId?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<AgentMessage, AgentRunResult, undefined>;

  /** Check if this runtime is available in the current environment. */
  isAvailable(): Promise<boolean>;

  /** Interrupt a running execution. */
  interrupt(sessionId: string): Promise<void>;
}
