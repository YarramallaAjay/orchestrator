/**
 * Layer 4: SDK types for the fluent agent builder.
 *
 * Users create agents with:
 *   Agent.create('my-agent')
 *     .runtime('claude-code')
 *     .capability('file-edit', 'shell')
 *     .memory({ scope: 'workflow', access: 'read-write' })
 *     .on(Events.TASK_COMPLETE, handler)
 *     .build()
 */

import type { Scope, AgentDefinition } from '../../platform/types.js';
import type { PlatformEvent } from '../../layer2-core/events/types.js';

// ─── Builder Types ──────────────────────────────────────────────────────────

export interface MemoryConfig {
  scope: Scope | 'global' | 'project' | 'workflow' | 'agent';
  access: 'read-only' | 'read-write';
  subscribe?: string[];
}

export interface PreferencesConfig {
  fallbackRuntime?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface TriggerConfig {
  onEvent?: string;
  onSchedule?: string;
}

/**
 * Context passed to event handlers during execution.
 */
export interface AgentContext {
  /** The agent's unique execution ID. */
  executionId: string;
  /** The agent definition. */
  agent: AgentDefinition;
  /** The input prompt/task. */
  input: string;

  /** Scoped KV memory access. */
  memory: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /** Event emission. */
  events: {
    emit(type: string, payload?: Record<string, unknown>): Promise<void>;
  };

  /** Output from the runtime (available in TASK_COMPLETE handler). */
  output?: {
    content: string;
    artifacts?: Record<string, unknown>;
    filesModified?: string[];
  };

  /** Error details (available in TASK_FAILED handler). */
  error?: Error;
}

export type EventHandler = (ctx: AgentContext) => void | Promise<void>;

/**
 * Events that agent builders can subscribe to.
 */
export const Events = {
  TASK_ASSIGNED: 'task:assigned',
  TASK_STARTED: 'task:started',
  CONTEXT_UPDATED: 'context:updated',
  TASK_COMPLETE: 'task:complete',
  TASK_FAILED: 'task:failed',
  TASK_RETRYING: 'task:retrying',
} as const;

export type AgentEventType = (typeof Events)[keyof typeof Events];

/**
 * The fluent builder interface for creating agents.
 */
export interface AgentBuilder {
  /**
   * Set the runtime adapter to use.
   * If omitted, the platform resolves via capability matching + preferences.
   */
  runtime(type: string): AgentBuilder;

  /**
   * Declare capabilities this agent needs.
   * Used for runtime matching when no explicit runtime is set.
   */
  capability(...caps: string[]): AgentBuilder;

  /**
   * Configure memory access.
   */
  memory(config: MemoryConfig): AgentBuilder;

  /**
   * Set execution preferences.
   */
  preferences(config: PreferencesConfig): AgentBuilder;

  /**
   * Set a description for this agent.
   */
  description(desc: string): AgentBuilder;

  /**
   * Set the system prompt / instructions.
   */
  instructions(prompt: string): AgentBuilder;

  /**
   * Configure triggers.
   */
  trigger(config: TriggerConfig): AgentBuilder;

  /**
   * Register an event handler.
   */
  on(event: AgentEventType | string, handler: EventHandler): AgentBuilder;

  /**
   * Pass adapter-specific configuration.
   */
  adapterConfig(config: Record<string, unknown>): AgentBuilder;

  /**
   * Build the final agent definition.
   */
  build(): AgentDefinition;
}

// ─── Workflow Builder ───────────────────────────────────────────────────────

/**
 * For M2+ : Workflow composition builder.
 * Users wire agents together into DAGs, pipelines, or event-driven flows.
 */
export interface WorkflowBuilder {
  /** Add an agent to the workflow. */
  agent(name: string, agent: AgentDefinition): WorkflowBuilder;

  /** Declare a dependency: `to` depends on `from`. */
  dependsOn(to: string, from: string): WorkflowBuilder;

  /** Build the workflow definition. */
  build(): WorkflowDefinition;
}

export interface WorkflowDefinition {
  id: string;
  agents: Map<string, AgentDefinition>;
  dependencies: Array<{ from: string; to: string }>;
}
