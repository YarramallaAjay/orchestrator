import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { evalRuns } from '../../db/schema.js';
import type { WebServerDeps } from '../server.js';

export function registerEvalRoutes(app: FastifyInstance, deps: WebServerDeps) {
  // List eval runs
  app.get('/api/evals', async (req, reply) => {
    const query = req.query as { limit?: string };
    const limit = parseInt(query.limit ?? '50');

    const runs = deps.db
      .select()
      .from(evalRuns)
      .orderBy(desc(evalRuns.startedAt))
      .limit(limit)
      .all();

    return runs.map((r) => ({
      id: r.id,
      scenarioName: r.scenarioName,
      projectId: r.projectId,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      metrics: r.metrics ? JSON.parse(r.metrics) : null,
    }));
  });

  // Get eval result with full metrics
  app.get('/api/evals/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const rows = deps.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.id, id))
      .all();

    const run = rows[0];
    if (!run) {
      reply.code(404);
      return { error: 'Eval run not found' };
    }

    return {
      id: run.id,
      scenarioName: run.scenarioName,
      projectId: run.projectId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      metrics: run.metrics ? JSON.parse(run.metrics) : null,
      config: run.config ? JSON.parse(run.config) : null,
      notes: run.notes,
    };
  });

  // Compare two eval runs
  app.get('/api/evals/:id/compare/:otherId', async (req, reply) => {
    const { id, otherId } = req.params as { id: string; otherId: string };

    const run1 = deps.db.select().from(evalRuns).where(eq(evalRuns.id, id)).all()[0];
    const run2 = deps.db.select().from(evalRuns).where(eq(evalRuns.id, otherId)).all()[0];

    if (!run1 || !run2) {
      reply.code(404);
      return { error: 'One or both eval runs not found' };
    }

    const metrics1 = run1.metrics ? JSON.parse(run1.metrics) : null;
    const metrics2 = run2.metrics ? JSON.parse(run2.metrics) : null;

    return {
      run1: { id: run1.id, scenario: run1.scenarioName, status: run1.status, metrics: metrics1 },
      run2: { id: run2.id, scenario: run2.scenarioName, status: run2.status, metrics: metrics2 },
    };
  });
}
