import { eq } from 'drizzle-orm';
import type { Db } from '../db/connection.js';
import { agentInstances } from '../db/schema.js';
import { generateId } from '../util/id.js';
import { logger } from '../util/logger.js';
import { AgentStatus, type AgentConfig, type AgentInstance } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import type { AgentRuntime } from './runtimes/runtime.js';

/**
 * Manages agent instance lifecycle: create, assign tasks, track status, retire.
 */
export class AgentManager {
  private activeInstances = new Map<string, AgentInstance>();

  constructor(
    private db: Db,
    private registry: AgentRegistry,
    private runtimes: Map<string, AgentRuntime>,
  ) {}

  /**
   * Create a new agent instance from a template.
   */
  async createInstance(templateId: string): Promise<AgentInstance> {
    const config = await this.registry.getById(templateId);
    if (!config) {
      throw new Error(`Agent template not found: ${templateId}`);
    }

    const runtime = this.runtimes.get(config.runtimeType);
    if (!runtime) {
      throw new Error(`Runtime not available: ${config.runtimeType}`);
    }

    const id = generateId('agent');
    const now = new Date().toISOString();

    const instance: AgentInstance = {
      id,
      config,
      status: AgentStatus.IDLE,
      currentTaskId: null,
      sessionId: null,
      createdAt: now,
      lastActiveAt: now,
      totalCostUsd: 0,
      turnsUsed: 0,
    };

    this.db.insert(agentInstances).values({
      id,
      templateId: config.id,
      status: AgentStatus.IDLE,
      createdAt: now,
      lastActiveAt: now,
    }).run();

    this.activeInstances.set(id, instance);
    logger.info({ agentId: id, template: templateId }, 'Agent instance created');

    return instance;
  }

  /**
   * Get an active agent instance.
   */
  getInstance(id: string): AgentInstance | null {
    return this.activeInstances.get(id) ?? null;
  }

  /**
   * List all instances.
   */
  listInstances(filter?: { status?: AgentStatus }): AgentInstance[] {
    const all = [...this.activeInstances.values()];
    if (filter?.status) {
      return all.filter((i) => i.status === filter.status);
    }
    return all;
  }

  /**
   * Assign a task to an agent instance.
   */
  async assignTask(agentId: string, taskId: string): Promise<void> {
    const instance = this.activeInstances.get(agentId);
    if (!instance) throw new Error(`Agent instance not found: ${agentId}`);

    instance.status = AgentStatus.RUNNING;
    instance.currentTaskId = taskId;
    instance.lastActiveAt = new Date().toISOString();

    this.db.update(agentInstances).set({
      status: AgentStatus.RUNNING,
      currentTaskId: taskId,
      lastActiveAt: instance.lastActiveAt,
    }).where(eq(agentInstances.id, agentId)).run();
  }

  /**
   * Mark an agent as idle after completing a task.
   */
  async completeTask(agentId: string, costUsd: number, turns: number, sessionId?: string): Promise<void> {
    const instance = this.activeInstances.get(agentId);
    if (!instance) return;

    instance.status = AgentStatus.IDLE;
    instance.currentTaskId = null;
    instance.totalCostUsd += costUsd;
    instance.turnsUsed += turns;
    instance.lastActiveAt = new Date().toISOString();
    if (sessionId) instance.sessionId = sessionId;

    this.db.update(agentInstances).set({
      status: AgentStatus.IDLE,
      currentTaskId: null,
      totalCostUsd: instance.totalCostUsd,
      turnsUsed: instance.turnsUsed,
      sessionId: instance.sessionId,
      lastActiveAt: instance.lastActiveAt,
    }).where(eq(agentInstances.id, agentId)).run();
  }

  /**
   * Terminate an agent instance.
   */
  async terminate(agentId: string): Promise<void> {
    const instance = this.activeInstances.get(agentId);
    if (!instance) return;

    // Interrupt if running
    if (instance.status === AgentStatus.RUNNING && instance.sessionId) {
      const runtime = this.runtimes.get(instance.config.runtimeType);
      if (runtime) {
        try {
          await runtime.interrupt(instance.sessionId);
        } catch { /* ignore */ }
      }
    }

    instance.status = AgentStatus.TERMINATED;
    this.activeInstances.delete(agentId);

    this.db.update(agentInstances).set({
      status: AgentStatus.TERMINATED,
      lastActiveAt: new Date().toISOString(),
    }).where(eq(agentInstances.id, agentId)).run();

    logger.info({ agentId }, 'Agent terminated');
  }

  /**
   * Get or create an idle agent instance for a given template.
   */
  async getOrCreateIdle(templateId: string): Promise<AgentInstance> {
    // Check for existing idle instance
    const idle = this.listInstances({ status: AgentStatus.IDLE })
      .find((i) => i.config.id === templateId);

    if (idle) return idle;

    return this.createInstance(templateId);
  }

  /**
   * Get total cost across all agents.
   */
  getTotalCost(): number {
    let total = 0;
    for (const instance of this.activeInstances.values()) {
      total += instance.totalCostUsd;
    }
    return total;
  }
}
