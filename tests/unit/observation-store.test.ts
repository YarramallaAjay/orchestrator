import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb, initializeDb } from '../../src/db/connection.js';
import { projects } from '../../src/db/schema.js';
import { ObservationStore } from '../../src/context/observation-store.js';
import type { AgentRunResult, AgentMessage } from '../../src/agent/runtimes/runtime.js';

const TEST_DB = '/tmp/orch-test-observations.db';
const PROJECT_ID = 'proj_obs_test';

describe('ObservationStore', () => {
  let db: ReturnType<typeof createDb>;
  let store: ObservationStore;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = createDb(TEST_DB);
    initializeDb(db);

    db.insert(projects).values({
      id: PROJECT_ID,
      name: 'Test Observations Project',
      rootPath: '/tmp',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    store = new ObservationStore(db);
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should add and retrieve observations', async () => {
    await store.add({
      projectId: PROJECT_ID,
      taskId: 'task_1',
      agentId: 'agent_1',
      type: 'convention',
      content: 'This project uses ESM modules',
      relevantFiles: ['/src/index.ts'],
      confidence: 0.8,
    });

    const results = await store.findRelevant(PROJECT_ID);

    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('convention');
    expect(results[0]!.content).toBe('This project uses ESM modules');
    expect(results[0]!.relevantFiles).toContain('/src/index.ts');
  });

  it('should filter observations by relevant files', async () => {
    await store.add({
      projectId: PROJECT_ID,
      taskId: 'task_1',
      agentId: 'agent_1',
      type: 'pattern',
      content: 'Auth uses JWT',
      relevantFiles: ['/src/auth.ts'],
      confidence: 0.7,
    });

    await store.add({
      projectId: PROJECT_ID,
      taskId: 'task_2',
      agentId: 'agent_1',
      type: 'pattern',
      content: 'DB uses Drizzle',
      relevantFiles: ['/src/db.ts'],
      confidence: 0.7,
    });

    const authObs = await store.findRelevant(PROJECT_ID, ['/src/auth.ts']);

    expect(authObs).toHaveLength(1);
    expect(authObs[0]!.content).toBe('Auth uses JWT');
  });

  it('should include generic observations (no relevant files) regardless of filter', async () => {
    await store.add({
      projectId: PROJECT_ID,
      taskId: 'task_1',
      agentId: 'agent_1',
      type: 'convention',
      content: 'Project uses strict TypeScript',
      relevantFiles: [],
      confidence: 0.9,
    });

    const results = await store.findRelevant(PROJECT_ID, ['/src/random.ts']);

    expect(results).toHaveLength(1);
  });

  it('should sort by confidence descending', async () => {
    await store.add({
      projectId: PROJECT_ID,
      taskId: 'task_1',
      agentId: 'agent_1',
      type: 'discovery',
      content: 'Low confidence finding',
      relevantFiles: [],
      confidence: 0.3,
    });

    await store.add({
      projectId: PROJECT_ID,
      taskId: 'task_2',
      agentId: 'agent_1',
      type: 'warning',
      content: 'High confidence warning',
      relevantFiles: [],
      confidence: 0.9,
    });

    const results = await store.findRelevant(PROJECT_ID);

    expect(results[0]!.confidence).toBe(0.9);
    expect(results[1]!.confidence).toBe(0.3);
  });

  it('should extract observations from agent messages', () => {
    const result: AgentRunResult = {
      success: true,
      messages: [
        {
          role: 'assistant',
          content: 'I noticed that all database queries use parameterized statements for security.',
          timestamp: new Date().toISOString(),
        },
        {
          role: 'assistant',
          content: 'Convention: All API routes follow the /api/v1/resource pattern.',
          timestamp: new Date().toISOString(),
        },
        {
          role: 'assistant',
          content: 'Warning: The auth middleware does not validate token expiration properly.',
          timestamp: new Date().toISOString(),
        },
        {
          role: 'assistant',
          content: 'Just writing some code here, nothing special.',
          timestamp: new Date().toISOString(),
        },
      ],
      outputArtifacts: {},
      totalCostUsd: 0,
      turnsUsed: 1,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      sessionId: null,
    };

    const extracted = store.extractFromResult(result, {
      projectId: PROJECT_ID,
      taskId: 'task_1',
      agentId: 'agent_1',
    });

    expect(extracted).toHaveLength(3);

    const types = extracted.map((e) => e.type);
    expect(types).toContain('discovery');
    expect(types).toContain('convention');
    expect(types).toContain('warning');
  });

  it('should format observations as context', () => {
    const observations = [
      {
        id: 'obs_1',
        projectId: PROJECT_ID,
        taskId: 'task_1',
        agentId: 'agent_1',
        type: 'convention' as const,
        content: 'Uses ESM modules',
        relevantFiles: [],
        confidence: 0.8,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'obs_2',
        projectId: PROJECT_ID,
        taskId: 'task_2',
        agentId: 'agent_1',
        type: 'warning' as const,
        content: 'Auth token not validated',
        relevantFiles: [],
        confidence: 0.9,
        createdAt: new Date().toISOString(),
      },
    ];

    const formatted = store.formatForContext(observations);

    expect(formatted).toContain('Agent Observations');
    expect(formatted).toContain('Conventions');
    expect(formatted).toContain('Uses ESM modules');
    expect(formatted).toContain('Warnings');
    expect(formatted).toContain('Auth token not validated');
  });

  it('should return empty string for no observations', () => {
    const formatted = store.formatForContext([]);
    expect(formatted).toBe('');
  });
});
