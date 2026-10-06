/**
 * Layer 1: Runtime Adapter interfaces.
 *
 * Every runtime (Claude Code, Copilot, API services, CLI tools, agent frameworks)
 * implements this uniform interface. The platform doesn't care what's inside --
 * it talks to every runtime the same way.
 */

// ─── Runtime Adapter ────────────────────────────────────────────────────────

export type RuntimeState =
  | 'idle'
  | 'initializing'
  | 'running'
  | 'cancelled'
  | 'completed'
  | 'failed';

/**
 * Configuration passed to an adapter during initialization.
 */
export interface AdapterConfig {
  /** Unique ID for this adapter instance. */
  id: string;
  /** Runtime type name (e.g., 'claude-code', 'api', 'cli'). */
  type: string;
  /** Working directory for the execution. */
  cwd: string;
  /** Model to use (if applicable). */
  model?: string;
  /** Maximum turns/iterations (if applicable). */
  maxTurns?: number;
  /** Maximum budget in USD (if applicable). */
  maxBudgetUsd?: number;
  /** Environment variables to set. */
  env?: Record<string, string>;
  /** Tools the adapter is allowed to use. */
  allowedTools?: string[];
  /** Permission mode for the underlying runtime. */
  permissionMode?: 'default' | 'auto' | 'acceptEdits';
  /** System prompt to use. */
  systemPrompt?: string;
  /** Arbitrary adapter-specific configuration. */
  extra?: Record<string, unknown>;
}

/**
 * Input for a single execution.
 */
export interface ExecutionInput {
  /** The prompt / task description to execute. */
  prompt: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Context to inject (shared memory contents, upstream artifacts, etc.). */
  context?: string;
  /** Retry feedback from a previous failed attempt. */
  retryFeedback?: string;
}

/**
 * Events emitted during execution via the AsyncGenerator.
 */
export type RuntimeEvent =
  | RuntimeProgressEvent
  | RuntimeOutputEvent
  | RuntimeToolUseEvent
  | RuntimeErrorEvent
  | RuntimeDoneEvent;

export interface RuntimeProgressEvent {
  type: 'progress';
  message: string;
  percent?: number;
  timestamp: string;
}

export interface RuntimeOutputEvent {
  type: 'output';
  content: string;
  role: 'assistant' | 'system';
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface RuntimeToolUseEvent {
  type: 'tool_use';
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  timestamp: string;
}

export interface RuntimeErrorEvent {
  type: 'error';
  error: Error;
  recoverable: boolean;
  timestamp: string;
}

export interface RuntimeDoneEvent {
  type: 'done';
  result: RuntimeResult;
  timestamp: string;
}

/**
 * Final result after execution completes.
 */
export interface RuntimeResult {
  success: boolean;
  output: string;
  /** Files created or modified during execution. */
  filesModified?: string[];
  /** Structured artifacts produced. */
  artifacts?: Record<string, unknown>;
  /** Execution metrics from the runtime. */
  metrics: RuntimeMetrics;
}

export interface RuntimeMetrics {
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  turns: number;
}

/**
 * The core contract every runtime adapter must implement.
 *
 * Adapters are the boundary between the platform and external runtimes.
 * The platform manages lifecycle uniformly; adapters decide internally
 * whether they're stateful or stateless.
 */
export interface RuntimeAdapter {
  /** Runtime type identifier (e.g., 'claude-code', 'api', 'cli'). */
  readonly type: string;

  /** Capabilities this runtime provides (e.g., 'file-edit', 'shell', 'ui-generation'). */
  readonly capabilities: string[];

  /**
   * Initialize the adapter with configuration.
   * Called once before execution. Set up connections, validate config, etc.
   */
  initialize(config: AdapterConfig): Promise<void>;

  /**
   * Execute a task and yield events as they occur.
   *
   * The AsyncGenerator pattern allows the platform to:
   * - Stream progress to the UI in real-time
   * - Track costs as they accumulate
   * - Cancel mid-execution if needed
   *
   * The generator MUST yield a 'done' event as the final event.
   */
  execute(input: ExecutionInput): AsyncGenerator<RuntimeEvent, void, undefined>;

  /**
   * Request cancellation of the current execution.
   * The adapter should clean up resources and yield a 'done' event with success=false.
   */
  cancel(): Promise<void>;

  /**
   * Get the current state of the adapter.
   */
  status(): RuntimeState;
}
