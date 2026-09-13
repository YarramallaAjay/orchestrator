import { eq, and, inArray } from 'drizzle-orm';
import type { Db } from '../db/connection.js';
import { tasks, taskDependencies } from '../db/schema.js';
import { generateId } from '../util/id.js';
import { TaskTransitionError, TaskError } from '../util/errors.js';
import {
  TaskStatus,
  TaskClassification,
  VALID_TRANSITIONS,
  type Task,
  type TaskDependency,
  type CreateTaskInput,
} from './types.js';

function rowToTask(row: typeof tasks.$inferSelect, deps: string[]): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    classification: row.classification as TaskClassification,
    priority: row.priority,
    dependsOn: deps,
    assignedAgentId: row.assignedAgentId,
    worktreeId: row.worktreeId,
    attempt: row.attempt,
    maxRetries: row.maxRetries,
    inputContext: JSON.parse(row.inputContext),
    outputArtifacts: JSON.parse(row.outputArtifacts),
    acceptanceCriteria: JSON.parse(row.acceptanceCriteria),
    validationScript: row.validationScript,
    tags: JSON.parse(row.tags),
    estimatedEffort: row.estimatedEffort as Task['estimatedEffort'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

export class TaskRepository {
  constructor(private db: Db) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const now = new Date().toISOString();
    const id = generateId('task');

    const hasUnmetDeps = (input.dependsOn?.length ?? 0) > 0;
    const initialStatus = hasUnmetDeps ? TaskStatus.PENDING : TaskStatus.READY;

    this.db.insert(tasks).values({
      id,
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      title: input.title,
      description: input.description,
      status: initialStatus,
      classification: input.classification ?? TaskClassification.LOCAL,
      priority: input.priority ?? 100,
      maxRetries: input.maxRetries ?? 2,
      inputContext: JSON.stringify(input.inputContext ?? {}),
      acceptanceCriteria: JSON.stringify(input.acceptanceCriteria ?? []),
      validationScript: input.validationScript ?? null,
      tags: JSON.stringify(input.tags ?? []),
      estimatedEffort: input.estimatedEffort ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Add dependencies
    if (input.dependsOn) {
      for (const depId of input.dependsOn) {
        this.db.insert(taskDependencies).values({
          taskId: id,
          dependsOnTaskId: depId,
          type: 'BLOCKS',
        }).run();
      }
    }

    return this.getById(id) as Promise<Task>;
  }

  async getById(id: string): Promise<Task | null> {
    const rows = this.db.select().from(tasks).where(eq(tasks.id, id)).all();
    const row = rows[0];
    if (!row) return null;

    const deps = this.db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, id))
      .all()
      .map((d) => d.dependsOnTaskId);

    return rowToTask(row, deps);
  }

  async update(id: string, fields: Partial<Pick<Task, 'assignedAgentId' | 'worktreeId' | 'attempt' | 'outputArtifacts' | 'inputContext'>>): Promise<Task> {
    const updates: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };

    if (fields.assignedAgentId !== undefined) updates.assignedAgentId = fields.assignedAgentId;
    if (fields.worktreeId !== undefined) updates.worktreeId = fields.worktreeId;
    if (fields.attempt !== undefined) updates.attempt = fields.attempt;
    if (fields.outputArtifacts !== undefined) updates.outputArtifacts = JSON.stringify(fields.outputArtifacts);
    if (fields.inputContext !== undefined) updates.inputContext = JSON.stringify(fields.inputContext);

    this.db.update(tasks).set(updates).where(eq(tasks.id, id)).run();
    const task = await this.getById(id);
    if (!task) throw new TaskError(`Task not found: ${id}`);
    return task;
  }

  async delete(id: string): Promise<void> {
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
  }

  async transition(id: string, to: TaskStatus): Promise<Task> {
    const task = await this.getById(id);
    if (!task) throw new TaskError(`Task not found: ${id}`);

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed?.includes(to)) {
      throw new TaskTransitionError(id, task.status, to);
    }

    const updates: Record<string, unknown> = {
      status: to,
      updatedAt: new Date().toISOString(),
    };

    if (to === TaskStatus.RUNNING && !task.startedAt) {
      updates.startedAt = new Date().toISOString();
    }
    if (to === TaskStatus.COMPLETED || to === TaskStatus.FAILED || to === TaskStatus.CANCELLED) {
      updates.completedAt = new Date().toISOString();
    }

    this.db.update(tasks).set(updates).where(eq(tasks.id, id)).run();
    return this.getById(id) as Promise<Task>;
  }

  async findByProject(projectId: string): Promise<Task[]> {
    const rows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .all();

    return Promise.all(rows.map(async (row) => {
      const deps = this.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, row.id))
        .all()
        .map((d) => d.dependsOnTaskId);
      return rowToTask(row, deps);
    }));
  }

  async findByStatus(projectId: string, statuses: TaskStatus[]): Promise<Task[]> {
    const rows = this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, projectId),
          inArray(tasks.status, statuses),
        ),
      )
      .all();

    return Promise.all(rows.map(async (row) => {
      const deps = this.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, row.id))
        .all()
        .map((d) => d.dependsOnTaskId);
      return rowToTask(row, deps);
    }));
  }

  async findReady(projectId: string): Promise<Task[]> {
    return this.findByStatus(projectId, [TaskStatus.READY]);
  }

  async findByAgent(agentId: string): Promise<Task[]> {
    const rows = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.assignedAgentId, agentId))
      .all();

    return Promise.all(rows.map(async (row) => {
      const deps = this.db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, row.id))
        .all()
        .map((d) => d.dependsOnTaskId);
      return rowToTask(row, deps);
    }));
  }

  async addDependency(dep: TaskDependency): Promise<void> {
    this.db.insert(taskDependencies).values({
      taskId: dep.taskId,
      dependsOnTaskId: dep.dependsOnTaskId,
      type: dep.type,
    }).run();
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    this.db
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .run();
  }

  async getDependencies(taskId: string): Promise<TaskDependency[]> {
    return this.db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((row) => ({
        taskId: row.taskId,
        dependsOnTaskId: row.dependsOnTaskId,
        type: row.type as TaskDependency['type'],
      }));
  }

  async getDependents(taskId: string): Promise<TaskDependency[]> {
    return this.db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.dependsOnTaskId, taskId))
      .all()
      .map((row) => ({
        taskId: row.taskId,
        dependsOnTaskId: row.dependsOnTaskId,
        type: row.type as TaskDependency['type'],
      }));
  }
}
