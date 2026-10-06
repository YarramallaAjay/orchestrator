/**
 * DAG-based workflow scheduler.
 *
 * Manages a directed acyclic graph of WorkflowNodes, resolving dependencies,
 * detecting cycles, and determining which nodes are ready for execution.
 *
 * Adapted from the legacy TaskGraph with platform-native types.
 */

import { CycleDetectedError } from '../../util/errors.js';
import { NodeStatus, type WorkflowNode, type Scheduler, type SchedulerConstraints } from './scheduler-interface.js';

/**
 * DAG that tracks workflow nodes and their dependencies.
 * Delegates batch-selection to a pluggable Scheduler.
 */
export class DAGScheduler {
  private nodes = new Map<string, WorkflowNode>();
  /** nodeId → set of nodeIds it depends on */
  private edges = new Map<string, Set<string>>();
  /** nodeId → set of nodeIds that depend on it (reverse) */
  private reverseEdges = new Map<string, Set<string>>();

  private scheduler: Scheduler;

  constructor(scheduler?: Scheduler) {
    this.scheduler = scheduler ?? new DefaultPriorityScheduler();
  }

  // ─── Node Management ────────────────────────────────────────────────────

  addNode(node: WorkflowNode): void {
    this.nodes.set(node.id, node);
    if (!this.edges.has(node.id)) {
      this.edges.set(node.id, new Set());
    }
    if (!this.reverseEdges.has(node.id)) {
      this.reverseEdges.set(node.id, new Set());
    }

    for (const depId of node.dependsOn) {
      this.addDependency(depId, node.id);
    }
  }

  updateNode(node: WorkflowNode): void {
    this.nodes.set(node.id, node);
  }

  getNode(id: string): WorkflowNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): WorkflowNode[] {
    return [...this.nodes.values()];
  }

  size(): number {
    return this.nodes.size;
  }

  // ─── Dependency Management ──────────────────────────────────────────────

  addDependency(from: string, to: string): void {
    if (!this.edges.has(to)) {
      this.edges.set(to, new Set());
    }
    this.edges.get(to)!.add(from);

    if (!this.reverseEdges.has(from)) {
      this.reverseEdges.set(from, new Set());
    }
    this.reverseEdges.get(from)!.add(to);
  }

  removeDependency(from: string, to: string): void {
    this.edges.get(to)?.delete(from);
    this.reverseEdges.get(from)?.delete(to);
  }

  // ─── Scheduling ─────────────────────────────────────────────────────────

  /**
   * Get nodes whose dependencies are all completed.
   * Only returns PENDING or READY nodes.
   */
  getReadyNodes(): WorkflowNode[] {
    const ready: WorkflowNode[] = [];
    for (const [nodeId, node] of this.nodes) {
      if (node.status !== NodeStatus.PENDING && node.status !== NodeStatus.READY) {
        continue;
      }
      const deps = this.edges.get(nodeId) ?? new Set();
      const allMet = [...deps].every((depId) => {
        const dep = this.nodes.get(depId);
        return dep && dep.status === NodeStatus.COMPLETED;
      });
      if (allMet) {
        ready.push(node);
      }
    }
    return ready.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get the next batch of nodes to dispatch, using the pluggable scheduler.
   */
  getNextBatch(constraints: SchedulerConstraints): WorkflowNode[] {
    const ready = this.getReadyNodes();
    const runningCount = [...this.nodes.values()]
      .filter((n) => n.status === NodeStatus.RUNNING || n.status === NodeStatus.RETRYING)
      .length;

    return this.scheduler.getNextBatch(ready, runningCount, constraints);
  }

  // ─── Graph Analysis ─────────────────────────────────────────────────────

  /**
   * Detect cycles using DFS. Returns cycle path if found, null otherwise.
   */
  detectCycle(): string[] | null {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();

    for (const id of this.nodes.keys()) {
      color.set(id, WHITE);
    }

    for (const startId of this.nodes.keys()) {
      if (color.get(startId) !== WHITE) continue;

      const stack: string[] = [startId];
      parent.set(startId, null);

      while (stack.length > 0) {
        const id = stack[stack.length - 1]!;

        if (color.get(id) === WHITE) {
          color.set(id, GRAY);
          const deps = this.edges.get(id) ?? new Set();
          for (const depId of deps) {
            if (!this.nodes.has(depId)) continue;
            if (color.get(depId) === GRAY) {
              const cycle = [depId, id];
              let cur = id;
              while (cur !== depId) {
                cur = parent.get(cur)!;
                if (cur === null) break;
                cycle.push(cur);
              }
              return cycle.reverse();
            }
            if (color.get(depId) === WHITE) {
              parent.set(depId, id);
              stack.push(depId);
            }
          }
        } else {
          stack.pop();
          color.set(id, BLACK);
        }
      }
    }

    return null;
  }

  /**
   * Topological sort using Kahn's algorithm. Throws on cycle.
   */
  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
    }
    for (const [nodeId, deps] of this.edges) {
      if (this.nodes.has(nodeId)) {
        inDegree.set(nodeId, [...deps].filter((d) => this.nodes.has(d)).length);
      }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(id);

      const dependents = this.reverseEdges.get(id) ?? new Set();
      for (const depId of dependents) {
        if (!this.nodes.has(depId)) continue;
        const current = inDegree.get(depId) ?? 0;
        const next = current - 1;
        inDegree.set(depId, next);
        if (next === 0) {
          queue.push(depId);
        }
      }
    }

    if (sorted.length !== this.nodes.size) {
      const cycle = this.detectCycle();
      throw new CycleDetectedError(cycle ?? ['unknown']);
    }

    return sorted;
  }

  /**
   * Critical path: longest chain of dependencies (by count).
   */
  criticalPath(): WorkflowNode[] {
    const sorted = this.topologicalSort();
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();

    for (const id of sorted) {
      dist.set(id, 0);
      prev.set(id, null);
    }

    for (const id of sorted) {
      const dependents = this.reverseEdges.get(id) ?? new Set();
      for (const depId of dependents) {
        if (!this.nodes.has(depId)) continue;
        const newDist = (dist.get(id) ?? 0) + 1;
        if (newDist > (dist.get(depId) ?? 0)) {
          dist.set(depId, newDist);
          prev.set(depId, id);
        }
      }
    }

    let maxNode = sorted[0]!;
    let maxDist = 0;
    for (const [id, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        maxNode = id;
      }
    }

    const path: WorkflowNode[] = [];
    let current: string | null = maxNode;
    while (current !== null) {
      const node = this.nodes.get(current);
      if (node) path.push(node);
      current = prev.get(current) ?? null;
    }

    return path.reverse();
  }

  // ─── Traversal ──────────────────────────────────────────────────────────

  /**
   * Get all ancestor node IDs (transitive dependencies).
   */
  getAncestors(nodeId: string): Set<string> {
    const visited = new Set<string>();
    const stack = [...(this.edges.get(nodeId) ?? [])];

    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const deps = this.edges.get(id) ?? new Set();
      for (const depId of deps) {
        if (!visited.has(depId)) stack.push(depId);
      }
    }

    return visited;
  }

  /**
   * Get all descendant node IDs (transitive dependents).
   */
  getDescendants(nodeId: string): Set<string> {
    const visited = new Set<string>();
    const stack = [...(this.reverseEdges.get(nodeId) ?? [])];

    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const deps = this.reverseEdges.get(id) ?? new Set();
      for (const depId of deps) {
        if (!visited.has(depId)) stack.push(depId);
      }
    }

    return visited;
  }

  /**
   * Cancel a node and cascade-cancel all dependents.
   * Returns IDs of all cancelled nodes.
   */
  cascadeCancel(nodeId: string): string[] {
    const descendants = this.getDescendants(nodeId);
    const toCancel = [nodeId, ...descendants];
    const cancelled: string[] = [];

    for (const id of toCancel) {
      const node = this.nodes.get(id);
      if (node && !isTerminal(node.status)) {
        node.status = NodeStatus.CANCELLED;
        cancelled.push(id);
      }
    }

    return cancelled;
  }

  /**
   * Check if the workflow is complete (all nodes terminal).
   */
  isComplete(): boolean {
    for (const node of this.nodes.values()) {
      if (!isTerminal(node.status)) return false;
    }
    return this.nodes.size > 0;
  }

  /**
   * Check if the workflow has any failed nodes.
   */
  hasFailed(): boolean {
    for (const node of this.nodes.values()) {
      if (node.status === NodeStatus.FAILED) return true;
    }
    return false;
  }
}

// ─── Default Scheduler ──────────────────────────────────────────────────────

/**
 * Default scheduler: priority-ordered, concurrency-limited, budget-aware.
 */
export class DefaultPriorityScheduler implements Scheduler {
  getNextBatch(
    readyNodes: WorkflowNode[],
    runningCount: number,
    constraints: SchedulerConstraints,
  ): WorkflowNode[] {
    // Budget check
    if (
      constraints.maxBudgetUsd !== undefined &&
      constraints.currentCostUsd !== undefined &&
      constraints.currentCostUsd >= constraints.maxBudgetUsd
    ) {
      return [];
    }

    // How many slots are available?
    const available = Math.max(0, constraints.maxConcurrent - runningCount);
    if (available === 0) return [];

    // Already sorted by priority from getReadyNodes
    return readyNodes.slice(0, available);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isTerminal(status: NodeStatus): boolean {
  return (
    status === NodeStatus.COMPLETED ||
    status === NodeStatus.FAILED ||
    status === NodeStatus.CANCELLED
  );
}
