/**
 * Pluggable scheduler interface.
 *
 * The scheduler decides which tasks to dispatch next given the current state.
 * Users can replace the default scheduler with their own implementation.
 */

import type { AgentDefinition } from '../../platform/types.js';

// ─── Workflow Node ──────────────────────────────────────────────────────────

export enum NodeStatus {
  PENDING = 'pending',
  READY = 'ready',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  RETRYING = 'retrying',
}

/**
 * A node in a workflow DAG. Represents a single unit of work.
 */
export interface WorkflowNode {
  id: string;
  name: string;
  agent: AgentDefinition;
  status: NodeStatus;
  /** IDs of nodes this node depends on. */
  dependsOn: string[];
  /** The prompt/task for this node. */
  prompt: string;
  /** Priority (lower = higher priority). */
  priority: number;
  /** Current attempt number (1-based). */
  attempt: number;
  /** Output from the completed execution. */
  output?: string;
  /** Error message if failed. */
  error?: string;
  /** Artifacts produced by this node. */
  artifacts?: Record<string, unknown>;
}

// ─── Scheduler Constraints ──────────────────────────────────────────────────

export interface SchedulerConstraints {
  /** Maximum concurrent executions. */
  maxConcurrent: number;
  /** Maximum total budget (USD). Stop scheduling if exceeded. */
  maxBudgetUsd?: number;
  /** Current total cost so far. */
  currentCostUsd?: number;
}

// ─── Scheduler Interface ────────────────────────────────────────────────────

/**
 * The pluggable scheduler contract.
 *
 * Given a set of ready nodes and constraints, the scheduler decides
 * which subset to dispatch in the next batch.
 */
export interface Scheduler {
  /**
   * Select the next batch of nodes to execute.
   *
   * @param readyNodes Nodes whose dependencies are all met.
   * @param runningCount Number of currently running nodes.
   * @param constraints Scheduling constraints.
   * @returns Nodes to dispatch in this batch.
   */
  getNextBatch(
    readyNodes: WorkflowNode[],
    runningCount: number,
    constraints: SchedulerConstraints,
  ): WorkflowNode[];
}
