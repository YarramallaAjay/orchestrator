import type { Task } from '../../task/types.js';

export interface DagValidationResult {
  valid: boolean;
  hasCycles: boolean;
  cyclePath?: string[];
  orphanedTasks: string[];
  unreachableTasks: string[];
  maxDepth: number;
}

/**
 * Validates a task DAG for structural correctness.
 * Checks for cycles, orphaned tasks, and computes graph metrics.
 */
export function validateDag(tasks: Task[]): DagValidationResult {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const result: DagValidationResult = {
    valid: true,
    hasCycles: false,
    orphanedTasks: [],
    unreachableTasks: [],
    maxDepth: 0,
  };

  // Check for cycles using DFS
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cyclePath: string[] = [];

  function dfs(taskId: string): boolean {
    if (inStack.has(taskId)) {
      cyclePath.push(taskId);
      return true; // Cycle detected
    }
    if (visited.has(taskId)) return false;

    visited.add(taskId);
    inStack.add(taskId);

    const task = taskMap.get(taskId);
    if (task) {
      for (const depId of task.dependsOn) {
        if (dfs(depId)) {
          cyclePath.push(taskId);
          return true;
        }
      }
    }

    inStack.delete(taskId);
    return false;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (dfs(task.id)) {
        result.hasCycles = true;
        result.cyclePath = cyclePath.reverse();
        result.valid = false;
        break;
      }
    }
  }

  // Find orphaned tasks (depend on non-existent tasks)
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (!taskMap.has(depId)) {
        result.orphanedTasks.push(task.id);
        result.valid = false;
      }
    }
  }

  // Compute max depth
  const depthCache = new Map<string, number>();

  function getDepth(taskId: string): number {
    if (depthCache.has(taskId)) return depthCache.get(taskId)!;

    const task = taskMap.get(taskId);
    if (!task || task.dependsOn.length === 0) {
      depthCache.set(taskId, 0);
      return 0;
    }

    let maxDepDep = 0;
    for (const depId of task.dependsOn) {
      if (taskMap.has(depId)) {
        maxDepDep = Math.max(maxDepDep, getDepth(depId) + 1);
      }
    }

    depthCache.set(taskId, maxDepDep);
    return maxDepDep;
  }

  if (!result.hasCycles) {
    for (const task of tasks) {
      result.maxDepth = Math.max(result.maxDepth, getDepth(task.id));
    }
  }

  return result;
}
