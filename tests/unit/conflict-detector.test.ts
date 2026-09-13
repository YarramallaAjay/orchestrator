import { describe, it, expect } from 'vitest';
import { ConflictDetector } from '../../src/core/conflict-detector.js';
import type { AgentRunResult, AgentMessage } from '../../src/agent/runtimes/runtime.js';
import { TaskStatus, TaskClassification, type Task } from '../../src/task/types.js';

function makeResult(filePaths: string[]): AgentRunResult {
  const messages: AgentMessage[] = filePaths.map((fp) => ({
    role: 'assistant' as const,
    content: `[Tool: Write]`,
    toolUse: { name: 'Write', input: { file_path: fp } },
    timestamp: new Date().toISOString(),
  }));

  return {
    success: true,
    messages,
    outputArtifacts: {},
    totalCostUsd: 0,
    turnsUsed: 1,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: filePaths.length,
    sessionId: null,
  };
}

function makeTask(id: string, title: string, description: string): Task {
  return {
    id,
    projectId: 'proj_test',
    parentId: null,
    title,
    description,
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
  };
}

describe('ConflictDetector', () => {
  it('should detect no conflicts when tasks touch different files', () => {
    const detector = new ConflictDetector();

    detector.registerTaskFiles('task_1', makeResult(['/src/a.ts']));
    detector.registerTaskFiles('task_2', makeResult(['/src/b.ts']));

    const report = detector.detect();

    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toHaveLength(0);
  });

  it('should detect conflicts when tasks modify the same file', () => {
    const detector = new ConflictDetector();

    detector.registerTaskFiles('task_1', makeResult(['/src/shared.ts', '/src/a.ts']));
    detector.registerTaskFiles('task_2', makeResult(['/src/shared.ts', '/src/b.ts']));

    const report = detector.detect();

    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]!.taskIdA).toBe('task_1');
    expect(report.conflicts[0]!.taskIdB).toBe('task_2');
    expect(report.conflicts[0]!.sharedFiles).toContain('/src/shared.ts');
  });

  it('should detect multiple shared files', () => {
    const detector = new ConflictDetector();

    detector.registerTaskFiles('task_1', makeResult(['/src/config.ts', '/src/types.ts']));
    detector.registerTaskFiles('task_2', makeResult(['/src/config.ts', '/src/types.ts', '/src/other.ts']));

    const report = detector.detect();

    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts[0]!.sharedFiles).toHaveLength(2);
  });

  it('should detect pairwise conflicts among multiple tasks', () => {
    const detector = new ConflictDetector();

    detector.registerTaskFiles('task_1', makeResult(['/src/a.ts']));
    detector.registerTaskFiles('task_2', makeResult(['/src/a.ts']));
    detector.registerTaskFiles('task_3', makeResult(['/src/a.ts']));

    const report = detector.detect();

    // 3 pairs: (1,2), (1,3), (2,3)
    expect(report.conflicts).toHaveLength(3);
  });

  it('should reset tracked files', () => {
    const detector = new ConflictDetector();

    detector.registerTaskFiles('task_1', makeResult(['/src/a.ts']));
    detector.registerTaskFiles('task_2', makeResult(['/src/a.ts']));
    detector.reset();

    const report = detector.detect();

    expect(report.hasConflicts).toBe(false);
  });

  it('should predict conflicts from task descriptions', () => {
    const detector = new ConflictDetector();

    const tasks = [
      makeTask('t1', 'Update auth module', 'Modify src/auth.ts to add JWT validation'),
      makeTask('t2', 'Refactor auth', 'Refactor src/auth.ts for better error handling'),
      makeTask('t3', 'Add logging', 'Add logging to src/logger.ts'),
    ];

    const overlaps = detector.predictConflicts(tasks);

    // t1 and t2 both mention src/auth.ts
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toContain('t1');
    expect(overlaps[0]).toContain('t2');
  });

  it('should skip tasks with no file references in prediction', () => {
    const detector = new ConflictDetector();

    const tasks = [
      makeTask('t1', 'Design architecture', 'Think about the overall system design'),
      makeTask('t2', 'Plan API', 'Define the REST API endpoints'),
    ];

    const overlaps = detector.predictConflicts(tasks);

    expect(overlaps).toHaveLength(0);
  });

  it('should ignore tasks with no tool use in registration', () => {
    const detector = new ConflictDetector();
    const emptyResult: AgentRunResult = {
      success: true,
      messages: [{ role: 'assistant', content: 'Done.', timestamp: new Date().toISOString() }],
      outputArtifacts: {},
      totalCostUsd: 0,
      turnsUsed: 1,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      sessionId: null,
    };

    detector.registerTaskFiles('task_1', emptyResult);
    detector.registerTaskFiles('task_2', makeResult(['/src/a.ts']));

    const report = detector.detect();

    expect(report.hasConflicts).toBe(false);
  });
});
