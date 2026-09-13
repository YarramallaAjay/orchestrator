import { CycleDetectedError } from '../util/errors.js';
import { TaskStatus, isTerminal, type Task } from './types.js';

/**
 * In-memory dependency DAG for task scheduling.
 * Nodes are tasks, edges represent "must complete before" relationships.
 */
export class TaskGraph {
  /** taskId -> Task */
  private nodes = new Map<string, Task>();
  /** taskId -> set of taskIds it depends on */
  private edges = new Map<string, Set<string>>();
  /** taskId -> set of taskIds that depend on it (reverse edges) */
  private reverseEdges = new Map<string, Set<string>>();

  addTask(task: Task): void {
    this.nodes.set(task.id, task);
    if (!this.edges.has(task.id)) {
      this.edges.set(task.id, new Set());
    }
    if (!this.reverseEdges.has(task.id)) {
      this.reverseEdges.set(task.id, new Set());
    }

    // Add dependency edges from the task's dependsOn list
    for (const depId of task.dependsOn) {
      this.addDependency(depId, task.id);
    }
  }

  updateTask(task: Task): void {
    this.nodes.set(task.id, task);
  }

  /**
   * Add a directed edge: `from` must complete before `to` can start.
   */
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

  /**
   * Get all tasks whose dependencies are all in a terminal state.
   * Only returns tasks that are in PENDING or READY status.
   */
  getReadyTasks(): Task[] {
    const ready: Task[] = [];
    for (const [taskId, task] of this.nodes) {
      if (task.status !== TaskStatus.PENDING && task.status !== TaskStatus.READY) {
        continue;
      }
      const deps = this.edges.get(taskId) ?? new Set();
      const allMet = [...deps].every((depId) => {
        const dep = this.nodes.get(depId);
        return dep && dep.status === TaskStatus.COMPLETED;
      });
      if (allMet) {
        ready.push(task);
      }
    }
    return ready.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Detect cycles using DFS. Returns the cycle path if found, null otherwise.
   */
  detectCycle(): string[] | null {
    const WHITE = 0; // unvisited
    const GRAY = 1;  // in current DFS path
    const BLACK = 2; // fully processed

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
              // Found cycle - reconstruct path
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
   * Topological sort using Kahn's algorithm. Throws if cycle exists.
   */
  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
    }
    for (const [taskId, deps] of this.edges) {
      if (this.nodes.has(taskId)) {
        inDegree.set(taskId, [...deps].filter((d) => this.nodes.has(d)).length);
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
   * Critical path: longest chain of dependencies (by count, not time).
   */
  criticalPath(): Task[] {
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

    // Find the node with the maximum distance
    let maxNode = sorted[0]!;
    let maxDist = 0;
    for (const [id, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        maxNode = id;
      }
    }

    // Reconstruct path
    const path: Task[] = [];
    let current: string | null = maxNode;
    while (current !== null) {
      const task = this.nodes.get(current);
      if (task) path.push(task);
      current = prev.get(current) ?? null;
    }

    return path.reverse();
  }

  /**
   * Get all ancestor task IDs (transitive dependencies).
   */
  getAncestors(taskId: string): Set<string> {
    const visited = new Set<string>();
    const stack = [...(this.edges.get(taskId) ?? [])];

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
   * Get all descendant task IDs (transitive dependents).
   */
  getDescendants(taskId: string): Set<string> {
    const visited = new Set<string>();
    const stack = [...(this.reverseEdges.get(taskId) ?? [])];

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
   * Cancel a task and cascade-cancel all dependents.
   * Returns IDs of all cancelled tasks.
   */
  cascadeCancel(taskId: string): string[] {
    const descendants = this.getDescendants(taskId);
    const toCancel = [taskId, ...descendants];
    const cancelled: string[] = [];

    for (const id of toCancel) {
      const task = this.nodes.get(id);
      if (task && !isTerminal(task.status)) {
        task.status = TaskStatus.CANCELLED;
        cancelled.push(id);
      }
    }

    return cancelled;
  }

  getTask(taskId: string): Task | undefined {
    return this.nodes.get(taskId);
  }

  getAllTasks(): Task[] {
    return [...this.nodes.values()];
  }

  size(): number {
    return this.nodes.size;
  }
}
