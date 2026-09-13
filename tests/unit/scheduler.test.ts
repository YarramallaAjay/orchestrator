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

function makeAgent(id: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    name: `Agent ${id}`,
    role: 'developer',
    runtimeType: 'claude-cli',
    capabilities: [],
    ...overrides,
  };
}

describe('Scheduler', () => {
  const scheduler = new Scheduler();

  it('should assign tasks sorted by priority', () => {
    const tasks = [
      makeTask('a', { priority: 50 }),
      makeTask('b', { priority: 10 }),
      makeTask('c', { priority: 30 }),
    ];

    const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 10, currentRunning: 0 });

    expect(assignments).toHaveLength(3);
    expect(assignments[0]!.task.id).toBe('b');
    expect(assignments[1]!.task.id).toBe('c');
    expect(assignments[2]!.task.id).toBe('a');
  });

  it('should respect concurrency limits', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 2, currentRunning: 0 });
    expect(assignments).toHaveLength(2);
  });

  it('should account for currently running tasks', () => {
    const tasks = [makeTask('a'), makeTask('b')];
    const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 2, currentRunning: 1 });
    expect(assignments).toHaveLength(1);
  });

  it('should return no assignments when at capacity', () => {
    const tasks = [makeTask('a')];
    const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 2, currentRunning: 2 });
    expect(assignments).toHaveLength(0);
  });

  it('should match agents by capability', () => {
    const tasks = [
      makeTask('a', { tags: ['typescript'] }),
    ];
    const agents = [
      makeAgent('backend', {
        role: 'backend-developer',
        capabilities: [{ name: 'typescript', level: 'expert' }],
      }),
      makeAgent('frontend', {
        role: 'frontend-developer',
        capabilities: [{ name: 'react', level: 'expert' }],
      }),
    ];

    const assignments = scheduler.schedule(tasks, agents, { maxConcurrent: 5, currentRunning: 0 });
    expect(assignments[0]!.agent.id).toBe('backend');
  });

  it('should use default agent when no templates match', () => {
    const tasks = [makeTask('a')];
    const assignments = scheduler.schedule(tasks, [], { maxConcurrent: 5, currentRunning: 0 });
    expect(assignments[0]!.agent.id).toBe('default');
  });
});
