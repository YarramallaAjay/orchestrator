import type { Task } from '../task/types.js';
import type { AgentRunResult } from '../agent/runtimes/runtime.js';

export interface ConflictReport {
  hasConflicts: boolean;
  conflicts: Array<{
    taskIdA: string;
    taskIdB: string;
    sharedFiles: string[];
  }>;
}

/**
 * Detects file-level conflicts between parallel task executions.
 * Tracks actual files modified by each task and reports overlaps.
 */
export class ConflictDetector {
  private taskFiles = new Map<string, Set<string>>();

  /**
   * Register actual files touched by a completed task.
   */
  registerTaskFiles(taskId: string, result: AgentRunResult): void {
    const files = new Set<string>();

    for (const msg of result.messages) {
      if (!msg.toolUse) continue;

      const name = msg.toolUse.name.toLowerCase();
      if (name === 'write' || name === 'edit') {
        const filePath = (msg.toolUse.input as any)?.file_path ?? (msg.toolUse.input as any)?.path;
        if (typeof filePath === 'string') {
          files.add(filePath);
        }
      }
    }

    if (files.size > 0) {
      this.taskFiles.set(taskId, files);
    }
  }

  /**
   * Detect conflicts between all registered tasks.
   */
  detect(): ConflictReport {
    const conflicts: ConflictReport['conflicts'] = [];
    const taskIds = [...this.taskFiles.keys()];

    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        const idA = taskIds[i]!;
        const idB = taskIds[j]!;
        const filesA = this.taskFiles.get(idA)!;
        const filesB = this.taskFiles.get(idB)!;

        const shared: string[] = [];
        for (const file of filesA) {
          if (filesB.has(file)) {
            shared.push(file);
          }
        }

        if (shared.length > 0) {
          conflicts.push({ taskIdA: idA, taskIdB: idB, sharedFiles: shared });
        }
      }
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
    };
  }

  /**
   * Pre-execution: predict conflicts from task descriptions using regex.
   */
  predictConflicts(tasks: Task[]): Array<[string, string]> {
    const overlaps: Array<[string, string]> = [];
    const taskFiles = tasks.map((t) => ({
      id: t.id,
      files: this.extractFileReferences(t),
    }));

    for (let i = 0; i < taskFiles.length; i++) {
      for (let j = i + 1; j < taskFiles.length; j++) {
        const a = taskFiles[i]!;
        const b = taskFiles[j]!;
        for (const file of a.files) {
          if (b.files.has(file)) {
            overlaps.push([a.id, b.id]);
            break;
          }
        }
      }
    }

    return overlaps;
  }

  /**
   * Reset tracked files (for new orchestration session).
   */
  reset(): void {
    this.taskFiles.clear();
  }

  private extractFileReferences(task: Task): Set<string> {
    const files = new Set<string>();
    const text = `${task.title} ${task.description}`;

    const pattern = /(?:^|\s|`)([a-zA-Z0-9_./\-]+\.[a-zA-Z]{1,10})(?:\s|$|`|,|;|\))/g;
    for (const match of text.matchAll(pattern)) {
      if (match[1]) files.add(match[1]);
    }

    return files;
  }
}
