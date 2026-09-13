import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb, initializeDb } from '../../src/db/connection.js';
import { projects, orchestratorSessions, taskMetrics, tasks } from '../../src/db/schema.js';
import { SessionAnalytics } from '../../src/core/session-analytics.js';

const TEST_DB = '/tmp/orch-test-analytics.db';
const PROJECT_ID = 'proj_analytics_test';

describe('SessionAnalytics', () => {
  let db: ReturnType<typeof createDb>;
  let analytics: SessionAnalytics;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = createDb(TEST_DB);
    initializeDb(db);

    db.insert(projects).values({
      id: PROJECT_ID,
      name: 'Test Analytics Project',
      rootPath: '/tmp',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    analytics = new SessionAnalytics(db);
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should return empty insights for no sessions', async () => {
    const insights = await analytics.analyze(PROJECT_ID);

    expect(insights.totalSessions).toBe(0);
    expect(insights.avgCostUsd).toBe(0);
    expect(insights.completionRate).toBe(0);
  });

  it('should compute average metrics from sessions', async () => {
    const now = new Date().toISOString();

    db.insert(orchestratorSessions).values({
      id: 'session_1',
      projectId: PROJECT_ID,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      tasksPlanned: 10,
      tasksCompleted: 8,
      tasksFailed: 2,
      totalCostUsd: 0.5,
      durationMs: 60000,
    }).run();

    db.insert(orchestratorSessions).values({
      id: 'session_2',
      projectId: PROJECT_ID,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      tasksPlanned: 6,
      tasksCompleted: 6,
      tasksFailed: 0,
      totalCostUsd: 0.3,
      durationMs: 30000,
    }).run();

    const insights = await analytics.analyze(PROJECT_ID);

    expect(insights.totalSessions).toBe(2);
    expect(insights.avgCostUsd).toBeCloseTo(0.4, 5);
    expect(insights.avgTasksPlanned).toBe(8);
    expect(insights.avgDurationMs).toBe(45000);
    expect(insights.completionRate).toBeCloseTo(0.875, 3); // 14/16
  });

  it('should compute failure patterns', async () => {
    const now = new Date().toISOString();

    db.insert(orchestratorSessions).values({
      id: 'session_1',
      projectId: PROJECT_ID,
      status: 'completed',
      startedAt: now,
    }).run();

    db.insert(taskMetrics).values({
      id: 'tm_1',
      sessionId: 'session_1',
      projectId: PROJECT_ID,
      taskId: 'task_1',
      status: 'COMPLETED',
      createdAt: now,
    }).run();

    db.insert(taskMetrics).values({
      id: 'tm_2',
      sessionId: 'session_1',
      projectId: PROJECT_ID,
      taskId: 'task_2',
      status: 'FAILED',
      createdAt: now,
    }).run();

    db.insert(taskMetrics).values({
      id: 'tm_3',
      sessionId: 'session_1',
      projectId: PROJECT_ID,
      taskId: 'task_3',
      status: 'COMPLETED',
      createdAt: now,
    }).run();

    const insights = await analytics.analyze(PROJECT_ID);

    const completed = insights.failurePatterns.find((f) => f.status === 'COMPLETED');
    const failed = insights.failurePatterns.find((f) => f.status === 'FAILED');

    expect(completed?.count).toBe(2);
    expect(failed?.count).toBe(1);
  });

  it('should format insights for planner prompt', async () => {
    const now = new Date().toISOString();

    db.insert(orchestratorSessions).values({
      id: 'session_1',
      projectId: PROJECT_ID,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      tasksPlanned: 5,
      tasksCompleted: 4,
      tasksFailed: 1,
      totalCostUsd: 0.42,
      durationMs: 120000,
    }).run();

    const insights = await analytics.analyze(PROJECT_ID);
    const formatted = analytics.formatForPlannerPrompt(insights);

    expect(formatted).toContain('Historical Session Insights');
    expect(formatted).toContain('1 previous session');
    expect(formatted).toContain('$0.4200');
    expect(formatted).toContain('80%'); // 4/5 completion rate
  });

  it('should return empty string for no sessions in formatter', () => {
    const formatted = analytics.formatForPlannerPrompt({
      totalSessions: 0,
      avgDurationMs: 0,
      avgCostUsd: 0,
      avgTasksPlanned: 0,
      completionRate: 0,
      failurePatterns: [],
      costByEffort: {},
    });

    expect(formatted).toBe('');
  });
});
