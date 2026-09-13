import type { FastifyInstance } from 'fastify';
import { AgentRegistry } from '../../agent/agent-registry.js';
import type { WebServerDeps } from '../server.js';

export function registerAgentRoutes(app: FastifyInstance, deps: WebServerDeps) {
  const registry = new AgentRegistry(deps.db);

  // List agent templates
  app.get('/api/agents', async () => {
    return registry.listAll();
  });

  // Get agent template
  app.get('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await registry.getById(id);
    if (!agent) {
      reply.code(404);
      return { error: 'Agent template not found' };
    }
    return agent;
  });

  // Register agent template
  app.post('/api/agents', async (req, reply) => {
    const body = req.body as any;
    await registry.register({
      id: body.id,
      name: body.name,
      role: body.role,
      runtimeType: body.runtimeType ?? 'claude-cli',
      capabilities: body.capabilities ?? [],
      model: body.model,
      maxTurns: body.maxTurns,
      maxBudgetUsd: body.maxBudgetUsd,
      systemPrompt: body.systemPrompt,
      allowedTools: body.allowedTools ?? [],
      permissionMode: body.permissionMode ?? 'default',
      mcpServers: body.mcpServers ?? [],
    });
    reply.code(201);
    return { id: body.id };
  });

  // Delete agent template
  app.delete('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await registry.delete(id);
    return { deleted: true };
  });
}
