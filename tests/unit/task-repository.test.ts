import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { createDb, initializeDb } from '../../src/db/connection.js';
import { TaskRepository } from '../../src/task/task-repository.js';
import { TaskStatus, TaskClassification } from '../../src/task/types.js';
import { projects } from '../../src/db/schema.js';

const TEST_DB = '/tmp/orch-test-repo.db';
const PROJECT_ID = 'proj_test';

describe('TaskRepository', () => {
  let db: ReturnType<typeof createDb>;
  let repo: TaskRepository;

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    db = createDb(TEST_DB);
    initializeDb(db);

    // Create test project
    db.insert(projects).values({
      id: PROJECT_ID,
      name: 'Test',
      rootPath: '/tmp',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();

    repo = new TaskRepository(db);
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('should create a task', async () => {
    const task = await repo.create({
      projectId: PROJECT_ID,
      title: 'Test Task',
      description: 'A test task',
    });

    expect(task.id).toMatch(/^task_/);
    expect(task.title).toBe('Test Task');
    expect(task.status).toBe(TaskStatus.READY); // No deps, so READY
  });

  it('should create a task with dependencies as PENDING', async () => {
    const taskA = await repo.create({
      projectId: PROJECT_ID,
      title: 'Task A',
      description: 'First',
    });

    const taskB = await repo.create({
      projectId: PROJECT_ID,
      title: 'Task B',
      description: 'Depends on A',
      dependsOn: [taskA.id],
    });

    expect(taskB.status).toBe(TaskStatus.PENDING);
    expect(taskB.dependsOn).toContain(taskA.id);
  });

  it('should get a task by ID', async () => {
    const created = await repo.create({
      projectId: PROJECT_ID,
      title: 'Find Me',
      description: 'Test',
    });

    const found = await repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Find Me');
  });

  it('should transition task states', async () => {
    const task = await repo.create({
      projectId: PROJECT_ID,
      title: 'Transitions',
      description: 'Test',
    });

    expect(task.status).toBe(TaskStatus.READY);

    const running = await repo.transition(task.id, TaskStatus.RUNNING);
    expect(running.status).toBe(TaskStatus.RUNNING);
    expect(running.startedAt).not.toBeNull();

    const completed = await repo.transition(task.id, TaskStatus.COMPLETED);
    expect(completed.status).toBe(TaskStatus.COMPLETED);
    expect(completed.completedAt).not.toBeNull();
  });

  it('should reject invalid transitions', async () => {
    const task = await repo.create({
      projectId: PROJECT_ID,
      title: 'Invalid',
      description: 'Test',
    });

    await repo.transition(task.id, TaskStatus.RUNNING);
    await repo.transition(task.id, TaskStatus.COMPLETED);

    await expect(
      repo.transition(task.id, TaskStatus.RUNNING),
    ).rejects.toThrow('Invalid task transition');
  });

  it('should find tasks by status', async () => {
    await repo.create({ projectId: PROJECT_ID, title: 'Ready 1', description: 'R1' });
    await repo.create({ projectId: PROJECT_ID, title: 'Ready 2', description: 'R2' });

    const ready = await repo.findByStatus(PROJECT_ID, [TaskStatus.READY]);
    expect(ready).toHaveLength(2);
  });

  it('should find ready tasks', async () => {
    const a = await repo.create({ projectId: PROJECT_ID, title: 'A', description: 'A' });
    await repo.create({ projectId: PROJECT_ID, title: 'B', description: 'B', dependsOn: [a.id] });

    const ready = await repo.findReady(PROJECT_ID);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.title).toBe('A');
  });

  it('should handle dependencies', async () => {
    const a = await repo.create({ projectId: PROJECT_ID, title: 'A', description: 'A' });
    const b = await repo.create({ projectId: PROJECT_ID, title: 'B', description: 'B' });

    await repo.addDependency({ taskId: b.id, dependsOnTaskId: a.id, type: 'BLOCKS' });

    const deps = await repo.getDependencies(b.id);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.dependsOnTaskId).toBe(a.id);

    const dependents = await repo.getDependents(a.id);
    expect(dependents).toHaveLength(1);
    expect(dependents[0]!.taskId).toBe(b.id);
  });

  it('should update task fields', async () => {
    const task = await repo.create({ projectId: PROJECT_ID, title: 'Update', description: 'Test' });

    const updated = await repo.update(task.id, { attempt: 2 });
    expect(updated.attempt).toBe(2);
  });

  it('should delete tasks', async () => {
    const task = await repo.create({ projectId: PROJECT_ID, title: 'Delete', description: 'Test' });
    await repo.delete(task.id);

    const found = await repo.getById(task.id);
    expect(found).toBeNull();
  });
});
