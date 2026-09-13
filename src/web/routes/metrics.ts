import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { orchestratorSessions, taskMetrics } from '../../db/schema.js';
import type { WebServerDeps } from '../server.js';

export function registerMetricsRoutes(app: FastifyInstance, deps: WebServerDeps) {
  // Project-level aggregated metrics
  app.get('/api/metrics', async (req, reply) => {
    const sessions = deps.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.projectId, deps.projectId))
      .all();

    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    let totalTurns = 0;
    let totalTasksPlanned = 0;
    let totalTasksCompleted = 0;
    let totalTasksFailed = 0;
    let totalDuration = 0;

    for (const s of sessions) {
      totalCost += s.totalCostUsd;
      totalInputTokens += s.totalInputTokens;
      totalOutputTokens += s.totalOutputTokens;
      totalToolCalls += s.totalToolCalls;
      totalTurns += s.totalTurns;
      totalTasksPlanned += s.tasksPlanned;
      totalTasksCompleted += s.tasksCompleted;
      totalTasksFailed += s.tasksFailed;
      totalDuration += s.durationMs;
    }

    return {
      projectId: deps.projectId,
      totalSessions: sessions.length,
      totalTasksPlanned,
      totalTasksCompleted,
      totalTasksFailed,
      successRate: totalTasksPlanned > 0 ? totalTasksCompleted / totalTasksPlanned : 0,
      totalCostUsd: totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalToolCalls,
      totalTurns,
      totalDurationMs: totalDuration,
    };
  });

  // List sessions
  app.get('/api/metrics/sessions', async (req, reply) => {
    const query = req.query as { limit?: string };
    const limit = parseInt(query.limit ?? '50');

    const sessions = deps.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.projectId, deps.projectId))
      .orderBy(desc(orchestratorSessions.startedAt))
      .limit(limit)
      .all();

    return sessions;
  });

  // Session detail with task breakdown
  app.get('/api/metrics/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const sessionRows = deps.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.id, id))
      .all();

    const session = sessionRows[0];
    if (!session) {
      reply.code(404);
      return { error: 'Session not found' };
    }

    const tasks = deps.db
      .select()
      .from(taskMetrics)
      .where(eq(taskMetrics.sessionId, id))
      .all();

    return {
      ...session,
      taskMetrics: tasks,
    };
  });
}
