/**
 * Layer 2: Event system types.
 *
 * Pub/sub event bus with wildcard pattern matching.
 * Used for cross-agent coordination, lifecycle tracking, and reactive composition.
 */

// ─── Events ─────────────────────────────────────────────────────────────────

export interface PlatformEvent {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  projectId?: string;
  workflowId?: string;
  agentId?: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

/**
 * Well-known event types emitted by the platform.
 */
export const EventTypes = {
  // Agent lifecycle
  AGENT_INITIALIZED: 'agent.initialized',
  AGENT_STARTED: 'agent.started',
  AGENT_PROGRESS: 'agent.progress',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_FAILED: 'agent.failed',
  AGENT_CANCELLED: 'agent.cancelled',

  // Workflow lifecycle
  WORKFLOW_STARTED: 'workflow.started',
  WORKFLOW_STEP_COMPLETED: 'workflow.step.completed',
  WORKFLOW_COMPLETED: 'workflow.completed',
  WORKFLOW_FAILED: 'workflow.failed',

  // Memory events
  MEMORY_KV_CHANGED: 'memory.kv.changed',
  MEMORY_DOC_UPDATED: 'memory.doc.updated',

  // Execution
  EXECUTION_STARTED: 'execution.started',
  EXECUTION_COMPLETED: 'execution.completed',
  EXECUTION_FAILED: 'execution.failed',
  EXECUTION_RETRYING: 'execution.retrying',

  // User-defined events (agents can emit custom events)
  CUSTOM: 'custom',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes] | string;

// ─── Event Bus Interface ────────────────────────────────────────────────────

export type EventHandler = (event: PlatformEvent) => void | Promise<void>;

export interface EventBus {
  /**
   * Publish an event. All matching subscribers are notified.
   */
  publish(event: PlatformEvent): Promise<void>;

  /**
   * Subscribe to events matching a pattern.
   * Supports glob-style matching:
   *   - 'agent.completed' — exact match
   *   - 'agent.*' — matches agent.completed, agent.failed, etc.
   *   - '*' — matches everything
   *
   * Returns an unsubscribe function.
   */
  subscribe(pattern: string, handler: EventHandler): () => void;

  /**
   * Subscribe to an event pattern, but only fire once.
   */
  once(pattern: string, handler: EventHandler): () => void;

  /**
   * Wait for a specific event pattern. Returns a promise that resolves
   * with the first matching event.
   */
  waitFor(pattern: string, timeoutMs?: number): Promise<PlatformEvent>;

  /**
   * Remove all subscribers.
   */
  clear(): void;
}
