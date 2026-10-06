/**
 * Layer 3: Execution engine types.
 */

import type { AgentDefinition, ExecutionResult, ExecutionMetrics } from '../../platform/types.js';
import type { RuntimeEvent } from '../../layer1-adapters/types.js';

/**
 * A single execution request submitted to the engine.
 */
export interface ExecutionRequest {
  /** Unique execution ID. */
  id: string;
  /** The agent to execute. */
  agent: AgentDefinition;
  /** The task/prompt to execute. */
  prompt: string;
  /** Working directory. */
  cwd: string;
  /** Optional context to inject. */
  context?: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Retry feedback from previous attempt. */
  retryFeedback?: string;
  /** Which attempt this is (1-based). */
  attempt: number;
  /** Workflow ID if this execution is part of a workflow. */
  workflowId?: string;
  /** Project ID. */
  projectId?: string;
}

/**
 * Callback for receiving execution events in real-time.
 */
export type ExecutionEventCallback = (
  executionId: string,
  event: RuntimeEvent,
) => void;

/**
 * The execution engine's public interface.
 */
export interface ExecutionEngine {
  /**
   * Execute a single agent task.
   * Returns the final result after the agent completes (or fails/cancels).
   */
  execute(request: ExecutionRequest): Promise<ExecutionResult>;

  /**
   * Execute with event streaming.
   * Yields runtime events as they occur, returns the final result.
   */
  executeStreaming(
    request: ExecutionRequest,
  ): AsyncGenerator<RuntimeEvent, ExecutionResult, undefined>;

  /**
   * Cancel a running execution.
   */
  cancel(executionId: string): Promise<void>;

  /**
   * Get the status of an execution.
   */
  getStatus(executionId: string): ExecutionRequest | null;
}
