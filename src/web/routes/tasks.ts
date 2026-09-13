import type { FastifyInstance } from 'fastify';
import { TaskRepository } from '../../task/task-repository.js';
import { TaskStatus, TaskClassification } from '../../task/types.js';
import type { WebServerDeps } from '../server.js';

export function registerTaskRoutes(app: FastifyInstance, deps: WebServerDeps) {
  const repo = new TaskRepository(deps.db);

  // List all tasks
  app.get('/api/tasks', async (req, reply) => {
    const query = req.query as { status?: string };
    if (query.status) {
      const statuses = query.status.split(',') as TaskStatus[];
      const tasks = await repo.findByStatus(deps.projectId, statuses);
      return tasks;
    }
    return repo.findByProject(deps.projectId);
  });

  // Get single task
  app.get('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await repo.getById(id);
    if (!task) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // Create task
  app.post('/api/tasks', async (req, reply) => {
    const body = req.body as {
      title: string;
      description: string;
      classification?: string;
      priority?: number;
      dependsOn?: string[];
      tags?: string[];
      acceptanceCriteria?: string[];
      validationScript?: string;
    };

    const task = await repo.create({
      projectId: deps.projectId,
      title: body.title,
      description: body.description,
      classification: (body.classification as TaskClassification) ?? TaskClassification.LOCAL,
      priority: body.priority ?? 100,
      dependsOn: body.dependsOn ?? [],
      tags: body.tags ?? [],
      acceptanceCriteria: body.acceptanceCriteria ?? [],
      validationScript: body.validationScript,
    });

    reply.code(201);
    return task;
  });

  // Transition task state
  app.patch('/api/tasks/:id/transition', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status: string };
    try {
      const task = await repo.transition(id, status as TaskStatus);
      return task;
    } catch (error: any) {
      reply.code(400);
      return { error: error.message };
    }
  });

  // Cancel task
  app.post('/api/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const task = await repo.transition(id, TaskStatus.CANCELLED);
      return task;
    } catch (error: any) {
      reply.code(400);
      return { error: error.message };
    }
  });

  // Get task dependencies
  app.get('/api/tasks/:id/dependencies', async (req, reply) => {
    const { id } = req.params as { id: string };
    return repo.getDependencies(id);
  });

  // Get task dependents
  app.get('/api/tasks/:id/dependents', async (req, reply) => {
    const { id } = req.params as { id: string };
    return repo.getDependents(id);
  });

  // Get project status summary
  app.get('/api/status', async (req, reply) => {
    const tasks = await repo.findByProject(deps.projectId);
    const counts: Record<string, number> = {};
    for (const task of tasks) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }
    const total = tasks.length;
    const completed = counts[TaskStatus.COMPLETED] ?? 0;
    return {
      total,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0,
      counts,
    };
  });
}
