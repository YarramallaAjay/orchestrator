import { eq } from 'drizzle-orm';
import type { Db } from '../db/connection.js';
import { mcpServers } from '../db/schema.js';
import { generateId } from '../util/id.js';
import type { McpServerConfig } from '../config/types.js';

export interface McpToolInfo {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Registry for MCP server configurations and their discovered tools.
 */
export class McpRegistry {
  private toolCache = new Map<string, McpToolInfo[]>();

  constructor(private db: Db) {}

  /**
   * Register an MCP server configuration.
   */
  async register(config: McpServerConfig): Promise<void> {
    const existing = this.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, config.name))
      .all();

    if (existing.length > 0) {
      this.db.update(mcpServers).set({
        type: config.type,
        command: config.command ?? null,
        args: JSON.stringify(config.args),
        url: config.url ?? null,
        env: JSON.stringify(config.env),
        autoStart: config.autoStart,
      }).where(eq(mcpServers.name, config.name)).run();
    } else {
      this.db.insert(mcpServers).values({
        id: generateId('mcp'),
        name: config.name,
        type: config.type,
        command: config.command ?? null,
        args: JSON.stringify(config.args),
        url: config.url ?? null,
        env: JSON.stringify(config.env),
        autoStart: config.autoStart,
        createdAt: new Date().toISOString(),
      }).run();
    }
  }

  /**
   * Get all registered server configs.
   */
  async listServers(): Promise<McpServerConfig[]> {
    return this.db.select().from(mcpServers).all().map((row) => ({
      name: row.name,
      type: row.type as McpServerConfig['type'],
      command: row.command ?? undefined,
      args: JSON.parse(row.args),
      url: row.url ?? undefined,
      env: JSON.parse(row.env),
      autoStart: row.autoStart,
    }));
  }

  /**
   * Get a server config by name.
   */
  async getServer(name: string): Promise<McpServerConfig | null> {
    const rows = this.db.select().from(mcpServers).where(eq(mcpServers.name, name)).all();
    const row = rows[0];
    if (!row) return null;
    return {
      name: row.name,
      type: row.type as McpServerConfig['type'],
      command: row.command ?? undefined,
      args: JSON.parse(row.args),
      url: row.url ?? undefined,
      env: JSON.parse(row.env),
      autoStart: row.autoStart,
    };
  }

  /**
   * Cache discovered tools for a server.
   */
  setTools(serverName: string, tools: McpToolInfo[]): void {
    this.toolCache.set(serverName, tools);
  }

  /**
   * Get cached tools for a server.
   */
  getTools(serverName: string): McpToolInfo[] {
    return this.toolCache.get(serverName) ?? [];
  }

  /**
   * Get all discovered tools across all servers.
   */
  getAllTools(): McpToolInfo[] {
    const all: McpToolInfo[] = [];
    for (const tools of this.toolCache.values()) {
      all.push(...tools);
    }
    return all;
  }

  /**
   * Sync server configs from project configuration.
   */
  async syncFromConfig(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      await this.register(config);
    }
  }

  /**
   * Delete a server registration.
   */
  async delete(name: string): Promise<void> {
    this.db.delete(mcpServers).where(eq(mcpServers.name, name)).run();
    this.toolCache.delete(name);
  }
}
