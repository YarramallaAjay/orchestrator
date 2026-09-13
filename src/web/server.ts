import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/connection.js';
import type { EventBus } from '../events/event-bus.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerEventRoutes } from './routes/events.js';
import { registerContextRoutes } from './routes/context.js';
import { registerWorktreeRoutes } from './routes/worktrees.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { registerEvalRoutes } from './routes/evals.js';
import { logger } from '../util/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface WebServerDeps {
  db: Db;
  projectId: string;
  eventBus: EventBus;
  config: {
    port: number;
    host: string;
    rootPath: string;
    git: { worktreeDir: string; branchPrefix: string; integrationBranch: string };
  };
}

export async function createWebServer(deps: WebServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  await app.register(fastifyCors, { origin: true });

  // REST API routes
  registerTaskRoutes(app, deps);
  registerAgentRoutes(app, deps);
  registerEventRoutes(app, deps);
  registerContextRoutes(app, deps);
  registerWorktreeRoutes(app, deps);
  registerReviewRoutes(app, deps);
  registerEvalRoutes(app, deps);

  // Static dashboard files
  const staticPath = resolve(__dirname, 'static');
  await app.register(fastifyStatic, {
    root: staticPath,
    prefix: '/',
  });

  return app;
}

export async function startWebServer(deps: WebServerDeps): Promise<FastifyInstance> {
  const app = await createWebServer(deps);

  await app.listen({ port: deps.config.port, host: deps.config.host });
  logger.info({ port: deps.config.port, host: deps.config.host }, 'Web dashboard started');
  console.log(`Dashboard: http://${deps.config.host}:${deps.config.port}`);

  return app;
}
