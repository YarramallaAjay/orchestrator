import type { FastifyInstance } from 'fastify';
import { EventStore } from '../../events/event-store.js';
import type { WebServerDeps } from '../server.js';

export function registerEventRoutes(app: FastifyInstance, deps: WebServerDeps) {
  const store = new EventStore(deps.db);

  // Query event history
  app.get('/api/events', async (req) => {
    const query = req.query as { type?: string; since?: string; limit?: string };
    return store.query({
      projectId: deps.projectId,
      type: query.type,
      since: query.since,
      limit: query.limit ? parseInt(query.limit) : 50,
    });
  });

  // Event count by type
  app.get('/api/events/counts', async () => {
    return store.countByType(deps.projectId);
  });

  // SSE stream for live events
  app.get('/api/events/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial keepalive
    reply.raw.write(': keepalive\n\n');

    const unsub = deps.eventBus.subscribe('*', (event) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Connection may be closed
      }
    });

    // Send keepalive every 30 seconds
    const keepalive = setInterval(() => {
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        clearInterval(keepalive);
      }
    }, 30_000);

    req.raw.on('close', () => {
      unsub();
      clearInterval(keepalive);
    });
  });
}
