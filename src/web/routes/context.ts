import type { FastifyInstance } from 'fastify';
import { ContextRepository } from '../../context/context-repository.js';
import { ContextCategory } from '../../context/types.js';
import type { WebServerDeps } from '../server.js';

export function registerContextRoutes(app: FastifyInstance, deps: WebServerDeps) {
  const repo = new ContextRepository(deps.db);

  // List context entries
  app.get('/api/context', async (req) => {
    const query = req.query as { category?: string };
    const category = query.category?.toUpperCase() as ContextCategory | undefined;
    return repo.list(deps.projectId, category);
  });

  // Get context entry
  app.get('/api/context/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const entry = await repo.get(deps.projectId, key);
    if (!entry) {
      reply.code(404);
      return { error: 'Context entry not found' };
    }
    return entry;
  });

  // Set context entry
  app.put('/api/context/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const body = req.body as {
      category: string;
      title: string;
      content: string;
      updatedBy?: string;
    };

    const entry = await repo.set({
      projectId: deps.projectId,
      key,
      category: body.category.toUpperCase() as ContextCategory,
      title: body.title,
      content: body.content,
      updatedBy: body.updatedBy ?? 'api',
    });

    return entry;
  });

  // Delete context entry
  app.delete('/api/context/:key', async (req) => {
    const { key } = req.params as { key: string };
    await repo.delete(deps.projectId, key);
    return { deleted: true };
  });

  // Get context history
  app.get('/api/context/:key/history', async (req) => {
    const { key } = req.params as { key: string };
    return repo.getHistory(deps.projectId, key);
  });
}
