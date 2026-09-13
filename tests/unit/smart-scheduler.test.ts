import { describe, it, expect } from 'vitest';
import { Scheduler } from '../../src/core/scheduler.js';
import { TaskStatus, TaskClassification, type Task } from '../../src/task/types.js';
import type { AgentConfig } from '../../src/agent/types.js';

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'proj_test',
    parentId: null,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status: TaskStatus.READY,
    classification: TaskClassification.LOCAL,
    priority: 100,
    dependsOn: [],
    assignedAgentId: null,
    worktreeId: null,
    attempt: 0,
    maxRetries: 2,
    inputContext: {},
    outputArtifacts: {},
    acceptanceCriteria: [],
    validationScript: null,
    tags: [],
    estimatedEffort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('Scheduler - Smart Features', () => {
  const scheduler = new Scheduler();

  describe('Cost-Aware Model Selection', () => {
    it('should use haiku for trivial effort tasks', () => {
      const tasks = [makeTask('a', { estimatedEffort: 'trivial' })];
      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      expect(assignments[0]!.agent.model).toBe('claude-haiku-4');
    });

    it('should use haiku for small effort tasks', () => {
      const tasks = [makeTask('a', { estimatedEffort: 'small' })];
      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      expect(assignments[0]!.agent.model).toBe('claude-haiku-4');
    });

    it('should use sonnet for medium effort tasks', () => {
      const tasks = [makeTask('a', { estimatedEffort: 'medium' })];
      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      expect(assignments[0]!.agent.model).toBe('claude-sonnet-4-6');
    });

    it('should use sonnet for large effort tasks', () => {
      const tasks = [makeTask('a', { estimatedEffort: 'large' })];
      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      expect(assignments[0]!.agent.model).toBe('claude-sonnet-4-6');
    });

    it('should use opus for xlarge effort tasks', () => {
      const tasks = [makeTask('a', { estimatedEffort: 'xlarge' })];
      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      expect(assignments[0]!.agent.model).toBe('claude-opus-4');
    });

    it('should keep default sonnet when no effort is set', () => {
      const tasks = [makeTask('a', { estimatedEffort: null })];
      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      expect(assignments[0]!.agent.model).toBe('claude-sonnet-4-6');
    });
  });

  describe('File Overlap Prevention', () => {
    it('should skip tasks with file conflicts in the same batch', () => {
      const tasks = [
        makeTask('a', {
          priority: 10,
          title: 'Update auth',
          description: 'Modify src/auth.ts to add JWT',
        }),
        makeTask('b', {
          priority: 20,
          title: 'Refactor auth',
          description: 'Refactor src/auth.ts for security',
        }),
        makeTask('c', {
          priority: 30,
          title: 'Add logging',
          description: 'Add src/logger.ts for structured logging',
        }),
      ];

      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      // Task a and c should be scheduled, b skipped (conflicts with a on src/auth.ts)
      expect(assignments).toHaveLength(2);
      expect(assignments[0]!.task.id).toBe('a');
      expect(assignments[1]!.task.id).toBe('c');
    });

    it('should schedule all tasks when no file overlaps', () => {
      const tasks = [
        makeTask('a', { title: 'Create API', description: 'Build src/api.ts endpoint handler' }),
        makeTask('b', { title: 'Create DB', description: 'Build src/db.ts database layer' }),
        makeTask('c', { title: 'Create UI', description: 'Build src/ui.ts interface' }),
      ];

      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });

      expect(assignments).toHaveLength(3);
    });

    it('should still respect concurrency limits with file overlap checks', () => {
      const tasks = [
        makeTask('a', { title: 'Task A', description: 'Work on src/a.ts' }),
        makeTask('b', { title: 'Task B', description: 'Work on src/b.ts' }),
        makeTask('c', { title: 'Task C', description: 'Work on src/c.ts' }),
      ];

      const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 2, currentRunning: 0 });

      expect(assignments).toHaveLength(2);
    });
  });

  describe('File Overlap Prediction', () => {
    it('should predict overlaps between tasks mentioning same files', () => {
      const tasks = [
        makeTask('t1', { title: 'Modify config', description: 'Update src/config.ts with new settings' }),
        makeTask('t2', { title: 'Add validation', description: 'Add validation to src/config.ts parser' }),
        makeTask('t3', { title: 'Add tests', description: 'Write tests/config.test.ts for config' }),
      ];

      const overlaps = scheduler.predictFileOverlaps(tasks);

      expect(overlaps).toHaveLength(1);
      expect(overlaps[0]).toEqual(['t1', 't2']);
    });

    it('should return no overlaps for unrelated tasks', () => {
      const tasks = [
        makeTask('t1', { title: 'Setup project', description: 'Initialize the project structure' }),
        makeTask('t2', { title: 'Design architecture', description: 'Plan the system design' }),
      ];

      const overlaps = scheduler.predictFileOverlaps(tasks);

      expect(overlaps).toHaveLength(0);
    });
  });
});
