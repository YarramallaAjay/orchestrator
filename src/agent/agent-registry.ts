import { eq } from 'drizzle-orm';
import type { Db } from '../db/connection.js';
import { agentTemplates } from '../db/schema.js';
import { generateId } from '../util/id.js';
import type { AgentConfig, AgentCapability } from './types.js';

/**
 * Registry for agent templates (configurations).
 * Backed by SQLite for persistence.
 */
export class AgentRegistry {
  constructor(private db: Db) {}

  /**
   * Register a new agent template.
   */
  async register(config: AgentConfig): Promise<void> {
    this.db.insert(agentTemplates).values({
      id: config.id,
      name: config.name,
      role: config.role,
      runtimeType: config.runtimeType,
      capabilities: JSON.stringify(config.capabilities),
      model: config.model ?? null,
      maxTurns: config.maxTurns ?? null,
      maxBudgetUsd: config.maxBudgetUsd ?? null,
      systemPrompt: config.systemPrompt ?? null,
      allowedTools: JSON.stringify(config.allowedTools ?? []),
      permissionMode: config.permissionMode ?? 'default',
      mcpServers: JSON.stringify(config.mcpServers ?? []),
      createdAt: new Date().toISOString(),
    }).run();
  }

  /**
   * Get a template by ID.
   */
  async getById(id: string): Promise<AgentConfig | null> {
    const rows = this.db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).all();
    return rows[0] ? this.rowToConfig(rows[0]) : null;
  }

  /**
   * List all templates.
   */
  async listAll(): Promise<AgentConfig[]> {
    return this.db.select().from(agentTemplates).all().map(this.rowToConfig);
  }

  /**
   * Find templates matching required capabilities.
   * Returns templates sorted by match quality (best first).
   */
  async findByCapabilities(required: AgentCapability[]): Promise<AgentConfig[]> {
    const all = await this.listAll();

    const scored = all.map((config) => {
      let score = 0;
      for (const req of required) {
        const match = config.capabilities.find((c) => c.name === req.name);
        if (match) {
          const levels: Record<string, number> = { basic: 1, proficient: 2, expert: 3 };
          const reqLevel = levels[req.level] ?? 0;
          const hasLevel = levels[match.level] ?? 0;
          if (hasLevel >= reqLevel) {
            score += hasLevel;
          }
        }
      }
      return { config, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.config);
  }

  /**
   * Delete a template.
   */
  async delete(id: string): Promise<void> {
    this.db.delete(agentTemplates).where(eq(agentTemplates.id, id)).run();
  }

  /**
   * Sync templates from config into the database.
   * Adds new templates, updates existing ones.
   */
  async syncFromConfig(configs: AgentConfig[]): Promise<void> {
    for (const config of configs) {
      const existing = await this.getById(config.id);
      if (existing) {
        this.db.update(agentTemplates).set({
          name: config.name,
          role: config.role,
          runtimeType: config.runtimeType,
          capabilities: JSON.stringify(config.capabilities),
          model: config.model ?? null,
          maxTurns: config.maxTurns ?? null,
          maxBudgetUsd: config.maxBudgetUsd ?? null,
          systemPrompt: config.systemPrompt ?? null,
          allowedTools: JSON.stringify(config.allowedTools ?? []),
          permissionMode: config.permissionMode ?? 'default',
          mcpServers: JSON.stringify(config.mcpServers ?? []),
        }).where(eq(agentTemplates.id, config.id)).run();
      } else {
        await this.register(config);
      }
    }
  }

  private rowToConfig(row: typeof agentTemplates.$inferSelect): AgentConfig {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      runtimeType: row.runtimeType as AgentConfig['runtimeType'],
      capabilities: JSON.parse(row.capabilities),
      model: row.model ?? undefined,
      maxTurns: row.maxTurns ?? undefined,
      maxBudgetUsd: row.maxBudgetUsd ?? undefined,
      systemPrompt: row.systemPrompt ?? undefined,
      allowedTools: JSON.parse(row.allowedTools),
      permissionMode: (row.permissionMode ?? 'default') as AgentConfig['permissionMode'],
      mcpServers: JSON.parse(row.mcpServers),
    };
  }
}
