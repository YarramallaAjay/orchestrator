import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerConfig } from '../config/types.js';
import type { McpRegistry, McpToolInfo } from './mcp-registry.js';
import { logger } from '../util/logger.js';

interface McpConnection {
  config: McpServerConfig;
  process: ChildProcess | null;
  connected: boolean;
  tools: McpToolInfo[];
}

/**
 * Manages MCP server connections lifecycle.
 * Handles starting/stopping stdio servers and connecting to remote servers.
 * Routes tool calls to the appropriate server.
 */
export class McpManager {
  private connections = new Map<string, McpConnection>();

  constructor(private registry: McpRegistry) {}

  /**
   * Connect to a registered MCP server.
   * For stdio servers, spawns the process.
   * For SSE/HTTP servers, validates the URL.
   */
  async connect(name: string): Promise<void> {
    const config = await this.registry.getServer(name);
    if (!config) {
      throw new Error(`MCP server not registered: ${name}`);
    }

    if (this.connections.has(name) && this.connections.get(name)!.connected) {
      logger.warn({ server: name }, 'Already connected');
      return;
    }

    const connection: McpConnection = {
      config,
      process: null,
      connected: false,
      tools: [],
    };

    if (config.type === 'stdio') {
      if (!config.command) {
        throw new Error(`stdio server ${name} requires a command`);
      }

      const proc = spawn(config.command, config.args, {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      connection.process = proc;

      // Wait for process to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve(); // Don't fail on timeout, process may be ready
        }, 5000);

        proc.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        proc.stderr?.on('data', (data) => {
          const msg = data.toString();
          logger.debug({ server: name, stderr: msg }, 'MCP server stderr');
        });

        // Give it a moment to start
        setTimeout(() => {
          clearTimeout(timeout);
          resolve();
        }, 1000);
      });

      connection.connected = true;
      logger.info({ server: name, type: 'stdio' }, 'MCP server connected');
    } else if (config.type === 'sse' || config.type === 'streamable-http') {
      if (!config.url) {
        throw new Error(`${config.type} server ${name} requires a url`);
      }
      // For remote servers, we just validate the config for now
      connection.connected = true;
      logger.info({ server: name, type: config.type, url: config.url }, 'MCP server registered');
    }

    this.connections.set(name, connection);

    // Discover tools
    await this.discoverTools(name);
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;

    if (connection.process) {
      connection.process.kill('SIGTERM');
      connection.process = null;
    }

    connection.connected = false;
    this.connections.delete(name);

    logger.info({ server: name }, 'MCP server disconnected');
  }

  /**
   * Connect to all registered servers marked with autoStart.
   */
  async connectAll(): Promise<void> {
    const servers = await this.registry.listServers();
    for (const server of servers) {
      if (server.autoStart) {
        try {
          await this.connect(server.name);
        } catch (error) {
          logger.error({ server: server.name, error }, 'Failed to connect MCP server');
        }
      }
    }
  }

  /**
   * Disconnect all connected servers.
   */
  async disconnectAll(): Promise<void> {
    for (const name of this.connections.keys()) {
      await this.disconnect(name);
    }
  }

  /**
   * List all available tools across connected servers.
   */
  listTools(): McpToolInfo[] {
    return this.registry.getAllTools();
  }

  /**
   * Get tools for a specific server.
   */
  getServerTools(name: string): McpToolInfo[] {
    return this.registry.getTools(name);
  }

  /**
   * Call a tool on a specific server.
   * For now, this sends a JSON-RPC message to the stdio process.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = this.connections.get(serverName);
    if (!connection || !connection.connected) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    if (connection.config.type === 'stdio' && connection.process) {
      return this.callStdioTool(connection, toolName, args);
    }

    throw new Error(`Tool calling not yet supported for ${connection.config.type} servers`);
  }

  /**
   * Check if a server is connected.
   */
  isConnected(name: string): boolean {
    return this.connections.get(name)?.connected ?? false;
  }

  /**
   * Get servers suitable for a given agent (by configured MCP server names).
   */
  getServersForAgent(mcpServerNames: string[]): McpServerConfig[] {
    const configs: McpServerConfig[] = [];
    for (const name of mcpServerNames) {
      const conn = this.connections.get(name);
      if (conn) {
        configs.push(conn.config);
      }
    }
    return configs;
  }

  private async discoverTools(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection?.connected) return;

    if (connection.config.type === 'stdio' && connection.process) {
      try {
        // Send tools/list request via JSON-RPC
        const request = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }) + '\n';

        connection.process.stdin?.write(request);

        // Wait for response
        const response = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
          connection.process?.stdout?.once('data', (data) => {
            clearTimeout(timeout);
            resolve(data.toString());
          });
        });

        const parsed = JSON.parse(response);
        if (parsed.result?.tools) {
          const tools: McpToolInfo[] = parsed.result.tools.map((t: any) => ({
            serverName: name,
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? {},
          }));
          connection.tools = tools;
          this.registry.setTools(name, tools);
          logger.info({ server: name, toolCount: tools.length }, 'Discovered MCP tools');
        }
      } catch (error) {
        logger.debug({ server: name, error }, 'Failed to discover tools');
      }
    }
  }

  private async callStdioTool(
    connection: McpConnection,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }) + '\n';

    connection.process?.stdin?.write(request);

    const response = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tool call timeout')), 30000);
      connection.process?.stdout?.once('data', (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
    });

    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(`MCP tool error: ${parsed.error.message}`);
    }
    return parsed.result;
  }
}
