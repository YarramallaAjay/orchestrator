import type { McpManager } from './mcp-manager.js';
import type { McpRegistry, McpToolInfo } from './mcp-registry.js';
import { logger } from '../util/logger.js';

/**
 * Routes tool calls to the appropriate MCP server.
 * Resolves tool names to servers and handles invocation.
 */
export class ToolRouter {
  constructor(
    private manager: McpManager,
    private registry: McpRegistry,
  ) {}

  /**
   * Find which server provides a given tool.
   */
  findServer(toolName: string): McpToolInfo | null {
    const allTools = this.registry.getAllTools();
    return allTools.find((t) => t.name === toolName) ?? null;
  }

  /**
   * Call a tool by name, automatically routing to the correct server.
   */
  async call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const toolInfo = this.findServer(toolName);
    if (!toolInfo) {
      throw new Error(`Tool not found: ${toolName}. Available tools: ${this.listToolNames().join(', ')}`);
    }

    if (!this.manager.isConnected(toolInfo.serverName)) {
      logger.info({ server: toolInfo.serverName }, 'Auto-connecting to MCP server');
      await this.manager.connect(toolInfo.serverName);
    }

    logger.debug({ tool: toolName, server: toolInfo.serverName }, 'Routing tool call');
    return this.manager.callTool(toolInfo.serverName, toolName, args);
  }

  /**
   * List all available tool names.
   */
  listToolNames(): string[] {
    return this.registry.getAllTools().map((t) => t.name);
  }

  /**
   * Get the schema for a specific tool.
   */
  getToolSchema(toolName: string): Record<string, unknown> | null {
    const toolInfo = this.findServer(toolName);
    return toolInfo?.inputSchema ?? null;
  }

  /**
   * Group tools by server.
   */
  getToolsByServer(): Map<string, McpToolInfo[]> {
    const grouped = new Map<string, McpToolInfo[]>();
    for (const tool of this.registry.getAllTools()) {
      const group = grouped.get(tool.serverName) ?? [];
      group.push(tool);
      grouped.set(tool.serverName, group);
    }
    return grouped;
  }
}
