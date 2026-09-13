import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb, initializeDb } from '../../src/db/connection.js';
import { projects, tasks, taskDependencies, events } from '../../src/db/schema.js';
import { MetricsCollector } from '../../src/eval/metrics-collector.js';
import { EventStore } from '../../src/events/event-store.js';
import { TaskStatus, TaskClassification } from '../../src/task/types.js';

const TEST_DB = '/tmp/orch-test-metrics.db';
const PROJECT_ID = 'proj_metrics_test';

describe('MetricsCollector', () => {
  let db: ReturnType<typeof createDb>;
  let collector: MetricsCollector;
  let eventStore: EventStore;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = createDb(TEST_DB);
    initializeDb(db);

    // Create test project
    db.insert(projects).values({
      id: PROJECT_ID,
      name: 'Test Metrics Project',
      rootPath: '/tmp',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    eventStore = new EventStore(db);
    collector = new MetricsCollector(db, eventStore);
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  function insertTask(id: string, overrides: Record<string, any> = {}) {
    const now = new Date().toISOString();
    db.insert(tasks).values({
      id,
      projectId: PROJECT_ID,
      title: `Task ${id}`,
      description: `Description for ${id}`,
      status: overrides.status ?? TaskStatus.COMPLETED,
      classification: overrides.classification ?? TaskClassification.LOCAL,
      priority: 100,
      attempt: overrides.attempt ?? 0,
      maxRetries: 2,
      inputContext: '{}',
      outputArtifacts: '{}',
      acceptanceCriteria: '[]',
      tags: '[]',
      createdAt: overrides.createdAt ?? now,
      updatedAt: now,
      startedAt: overrides.startedAt ?? now,
      completedAt: overrides.completedAt ?? now,
    }).run();
  }

  function insertEvent(type: string, payload: Record<string, any> = {}) {
    db.insert(events).values({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type,
      source: 'test',
      projectId: PROJECT_ID,
      payload: JSON.stringify(payload),
      timestamp: new Date().toISOString(),
    }).run();
  }

  it('should collect task counts', async () => {
    insertTask('task_1', { status: TaskStatus.COMPLETED });
    insertTask('task_2', { status: TaskStatus.COMPLETED });
    insertTask('task_3', { status: TaskStatus.FAILED });

    const planStart = Date.now() - 5000;
    const execStart = Date.now() - 4000;
    const metrics = await collector.collect(PROJECT_ID, planStart, execStart);

    expect(metrics.tasksPlanned).toBe(3);
    expect(metrics.tasksCompleted).toBe(2);
    expect(metrics.tasksFailed).toBe(1);
  });

  it('should collect classification breakdown', async () => {
    insertTask('task_1', { classification: TaskClassification.LOCAL });
    insertTask('task_2', { classification: TaskClassification.MODULE });
    insertTask('task_3', { classification: TaskClassification.MODULE });
    insertTask('task_4', { classification: TaskClassification.CROSS_MODULE });

    const metrics = await collector.collect(PROJECT_ID, Date.now() - 1000, Date.now());

    expect(metrics.tasksByClassification['LOCAL']).toBe(1);
    expect(metrics.tasksByClassification['MODULE']).toBe(2);
    expect(metrics.tasksByClassification['CROSS_MODULE']).toBe(1);
  });

  it('should collect retry metrics', async () => {
    insertTask('task_1', { attempt: 0 });
    insertTask('task_2', { attempt: 2, status: TaskStatus.FAILED });
    insertTask('task_3', { attempt: 1 });

    const metrics = await collector.collect(PROJECT_ID, Date.now() - 1000, Date.now());

    expect(metrics.tasksRetried).toBe(2);
    expect(metrics.totalRetries).toBe(3);
    expect(metrics.avgRetriesPerFailedTask).toBe(2);
  });

  it('should calculate timing metrics', async () => {
    const start = new Date('2026-01-01T10:00:00Z').toISOString();
    const mid = new Date('2026-01-01T10:05:00Z').toISOString();
    const end = new Date('2026-01-01T10:10:00Z').toISOString();

    insertTask('task_1', { startedAt: start, completedAt: mid }); // 5 min
    insertTask('task_2', { startedAt: mid, completedAt: end });   // 5 min

    const metrics = await collector.collect(PROJECT_ID, Date.now() - 1000, Date.now());

    expect(metrics.avgTaskDurationMs).toBe(300000); // 5 minutes
    expect(metrics.longestTaskMs).toBe(300000);
    expect(metrics.shortestTaskMs).toBe(300000);
  });

  it('should handle empty project', async () => {
    const metrics = await collector.collect(PROJECT_ID, Date.now() - 1000, Date.now());

    expect(metrics.tasksPlanned).toBe(0);
    expect(metrics.tasksCompleted).toBe(0);
    expect(metrics.validationPassRate).toBe(1);
    expect(metrics.avgTaskDurationMs).toBe(0);
  });

  it('should collect cost metrics from events', async () => {
    insertTask('task_1');
    insertEvent('agent.status_changed', {
      agentId: 'agent_1',
      costUsd: 0.5,
      turnsUsed: 10,
      to: 'IDLE',
    });
    insertEvent('agent.status_changed', {
      agentId: 'agent_2',
      costUsd: 0.3,
      turnsUsed: 5,
      to: 'IDLE',
    });

    const metrics = await collector.collect(PROJECT_ID, Date.now() - 1000, Date.now());

    expect(metrics.totalCostUsd).toBe(0.8);
    expect(metrics.costByAgent['agent_1']).toBe(0.5);
    expect(metrics.costByAgent['agent_2']).toBe(0.3);
    expect(metrics.agentsUsed).toBe(2);
  });

  it('should calculate validation metrics from events', async () => {
    insertTask('task_1');
    insertEvent('validation.completed', {});
    insertEvent('validation.completed', {});
    insertEvent('validation.failed', {});

    const metrics = await collector.collect(PROJECT_ID, Date.now() - 1000, Date.now());

    expect(metrics.validationChecks).toBe(3);
    expect(metrics.validationFailures).toBe(1);
    expect(metrics.validationPassRate).toBeCloseTo(0.6667, 3);
  });

  it('should calculate dependency depth', async () => {
    insertTask('task_1', { status: TaskStatus.COMPLETED });
    insertTask('task_2', { status: TaskStatus.COMPLETED });
    insertTask('task_3', { status: TaskStatus.COMPLETED });

    // task_2 depends on task_1, task_3 depends on task_2 (chain of 3)
    db.insert(taskDependencies).values({ taskId: 'task_2', dependsOnTaskId: 'task_1', type: 'BLOCKS' }).run();
    db.insert(taskDependencies).values({ taskId: 'task_3', dependsOnTaskId: 'task_2', type: 'BLOCKS' }).run();

    const metrics = await collector.collect(PROJECT_ID, Date.now() - 1000, Date.now());

    expect(metrics.dependencyDepth).toBe(3);
  });
});
