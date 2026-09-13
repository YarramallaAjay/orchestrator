import type { FastifyInstance } from 'fastify';
import { TaskRepository } from '../../task/task-repository.js';
import { HumanReviewManager } from '../../core/human-review.js';
import type { WebServerDeps } from '../server.js';

export function registerReviewRoutes(app: FastifyInstance, deps: WebServerDeps) {
  const taskRepo = new TaskRepository(deps.db);
  const reviewManager = new HumanReviewManager(taskRepo, deps.eventBus);

  // List pending reviews
  app.get('/api/reviews', async () => {
    return reviewManager.listPending();
  });

  // Get a review
  app.get('/api/reviews/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const review = reviewManager.getReview(id);
    if (!review) {
      reply.code(404);
      return { error: 'Review not found' };
    }
    return review;
  });

  // Resolve a review
  app.post('/api/reviews/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { resolution } = req.body as { resolution: string };
    try {
      await reviewManager.resolve(id, resolution);
      return { resolved: true };
    } catch (error: any) {
      reply.code(400);
      return { error: error.message };
    }
  });
}
