import { describe, it, expect, beforeEach } from 'vitest';
import { TaskGraph } from '../../src/task/task-graph.js';
import { TaskStatus, TaskClassification, type Task } from '../../src/task/types.js';

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'proj_test',
    parentId: null,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    status: TaskStatus.PENDING,
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

describe('TaskGraph', () => {
  let graph: TaskGraph;

  beforeEach(() => {
    graph = new TaskGraph();
  });

  it('should add tasks', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B'));
    expect(graph.size()).toBe(2);
  });

  it('should identify ready tasks (no dependencies)', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B'));
    const ready = graph.getReadyTasks();
    expect(ready).toHaveLength(2);
  });

  it('should block tasks with unmet dependencies', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));

    const ready = graph.getReadyTasks();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe('A');
  });

  it('should unblock tasks when dependencies complete', () => {
    const taskA = makeTask('A');
    graph.addTask(taskA);
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));

    expect(graph.getReadyTasks()).toHaveLength(1);

    // Mark A as completed
    taskA.status = TaskStatus.COMPLETED;
    graph.updateTask(taskA);

    const ready = graph.getReadyTasks();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe('B');
  });

  it('should sort ready tasks by priority', () => {
    graph.addTask(makeTask('A', { priority: 50 }));
    graph.addTask(makeTask('B', { priority: 10 }));
    graph.addTask(makeTask('C', { priority: 30 }));

    const ready = graph.getReadyTasks();
    expect(ready.map((t) => t.id)).toEqual(['B', 'C', 'A']);
  });

  it('should detect cycles', () => {
    graph.addTask(makeTask('A', { dependsOn: ['B'] }));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));

    const cycle = graph.detectCycle();
    expect(cycle).not.toBeNull();
  });

  it('should return null when no cycle exists', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));
    graph.addTask(makeTask('C', { dependsOn: ['B'] }));

    expect(graph.detectCycle()).toBeNull();
  });

  it('should topologically sort', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));
    graph.addTask(makeTask('C', { dependsOn: ['A'] }));
    graph.addTask(makeTask('D', { dependsOn: ['B', 'C'] }));

    const sorted = graph.topologicalSort();
    const aIdx = sorted.indexOf('A');
    const bIdx = sorted.indexOf('B');
    const cIdx = sorted.indexOf('C');
    const dIdx = sorted.indexOf('D');

    expect(aIdx).toBeLessThan(bIdx);
    expect(aIdx).toBeLessThan(cIdx);
    expect(bIdx).toBeLessThan(dIdx);
    expect(cIdx).toBeLessThan(dIdx);
  });

  it('should throw on topological sort with cycle', () => {
    graph.addTask(makeTask('A', { dependsOn: ['B'] }));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));

    expect(() => graph.topologicalSort()).toThrow('cycle');
  });

  it('should find ancestors', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));
    graph.addTask(makeTask('C', { dependsOn: ['B'] }));

    const ancestors = graph.getAncestors('C');
    expect(ancestors).toContain('A');
    expect(ancestors).toContain('B');
    expect(ancestors.size).toBe(2);
  });

  it('should find descendants', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));
    graph.addTask(makeTask('C', { dependsOn: ['A'] }));

    const descendants = graph.getDescendants('A');
    expect(descendants).toContain('B');
    expect(descendants).toContain('C');
    expect(descendants.size).toBe(2);
  });

  it('should cascade cancel', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));
    graph.addTask(makeTask('C', { dependsOn: ['B'] }));
    graph.addTask(makeTask('D')); // independent

    const cancelled = graph.cascadeCancel('A');
    expect(cancelled).toContain('A');
    expect(cancelled).toContain('B');
    expect(cancelled).toContain('C');
    expect(cancelled).not.toContain('D');
  });

  it('should find critical path', () => {
    graph.addTask(makeTask('A'));
    graph.addTask(makeTask('B', { dependsOn: ['A'] }));
    graph.addTask(makeTask('C', { dependsOn: ['B'] }));
    graph.addTask(makeTask('D', { dependsOn: ['A'] }));

    const path = graph.criticalPath();
    // Longest chain: A -> B -> C (length 3)
    expect(path.map((t) => t.id)).toEqual(['A', 'B', 'C']);
  });
});
