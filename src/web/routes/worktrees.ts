import type { FastifyInstance } from 'fastify';
import { WorktreeManager } from '../../git/worktree-manager.js';
import { MergeCoordinator } from '../../git/merge-coordinator.js';
import type { WebServerDeps } from '../server.js';

export function registerWorktreeRoutes(app: FastifyInstance, deps: WebServerDeps) {
  const manager = new WorktreeManager(deps.db, {
    projectId: deps.projectId,
    rootPath: deps.config.rootPath,
    worktreeDir: deps.config.git.worktreeDir,
    branchPrefix: deps.config.git.branchPrefix,
    integrationBranch: deps.config.git.integrationBranch,
  });
  const coordinator = new MergeCoordinator(manager);

  // List worktrees
  app.get('/api/worktrees', async () => {
    return manager.list();
  });

  // Get worktree
  app.get('/api/worktrees/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const wt = await manager.getById(id);
    if (!wt) {
      reply.code(404);
      return { error: 'Worktree not found' };
    }
    return wt;
  });

  // Merge worktree
  app.post('/api/worktrees/:id/merge', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { targetBranch?: string } | undefined;
    try {
      const result = await coordinator.mergeSingle(id, body?.targetBranch);
      return result;
    } catch (error: any) {
      reply.code(400);
      return { error: error.message };
    }
  });

  // Remove worktree
  app.delete('/api/worktrees/:id', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { deleteBranch?: string };
    await manager.remove(id, query.deleteBranch === 'true');
    return { deleted: true };
  });

  // Clean up worktrees
  app.post('/api/worktrees/cleanup', async () => {
    const cleaned = await manager.cleanup();
    return { cleaned };
  });

  // Plan integration
  app.get('/api/worktrees/integration/plan', async () => {
    return coordinator.planIntegration();
  });
}
