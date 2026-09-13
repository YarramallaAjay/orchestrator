import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { createDb, initializeDb } from '../../src/db/connection.js';
import { ContextRepository } from '../../src/context/context-repository.js';
import { ContextCategory } from '../../src/context/types.js';
import { projects } from '../../src/db/schema.js';

const TEST_DB = '/tmp/orch-test-context.db';
const PROJECT_ID = 'proj_test';

describe('ContextRepository', () => {
  let db: ReturnType<typeof createDb>;
  let repo: ContextRepository;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = createDb(TEST_DB);
    initializeDb(db);

    db.insert(projects).values({
      id: PROJECT_ID,
      name: 'Test',
      rootPath: '/tmp',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    repo = new ContextRepository(db);
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should create a context entry', async () => {
    const entry = await repo.set({
      projectId: PROJECT_ID,
      key: 'arch:database',
      category: ContextCategory.ARCHITECTURE,
      title: 'Database Architecture',
      content: 'Using PostgreSQL with Drizzle ORM',
      updatedBy: 'human',
    });

    expect(entry.key).toBe('arch:database');
    expect(entry.version).toBe(1);
  });

  it('should update with version history', async () => {
    await repo.set({
      projectId: PROJECT_ID,
      key: 'arch:api',
      category: ContextCategory.API_CONTRACT,
      title: 'API Contract',
      content: 'V1 contract',
      updatedBy: 'human',
    });

    const updated = await repo.set({
      projectId: PROJECT_ID,
      key: 'arch:api',
      category: ContextCategory.API_CONTRACT,
      title: 'API Contract',
      content: 'V2 contract updated',
      updatedBy: 'agent',
    });

    expect(updated.version).toBe(2);
    expect(updated.content).toBe('V2 contract updated');

    const history = await repo.getHistory(PROJECT_ID, 'arch:api');
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe('V1 contract');
  });

  it('should list by category', async () => {
    await repo.set({
      projectId: PROJECT_ID,
      key: 'dec:auth',
      category: ContextCategory.DECISION,
      title: 'Auth',
      content: 'Use JWT',
      updatedBy: 'human',
    });

    await repo.set({
      projectId: PROJECT_ID,
      key: 'arch:db',
      category: ContextCategory.ARCHITECTURE,
      title: 'DB',
      content: 'PostgreSQL',
      updatedBy: 'human',
    });

    const decisions = await repo.list(PROJECT_ID, ContextCategory.DECISION);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.key).toBe('dec:auth');

    const all = await repo.list(PROJECT_ID);
    expect(all).toHaveLength(2);
  });

  it('should delete entries', async () => {
    await repo.set({
      projectId: PROJECT_ID,
      key: 'temp',
      category: ContextCategory.DECISION,
      title: 'Temp',
      content: 'Delete me',
      updatedBy: 'human',
    });

    await repo.delete(PROJECT_ID, 'temp');
    const found = await repo.get(PROJECT_ID, 'temp');
    expect(found).toBeNull();
  });
});
