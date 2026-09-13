#!/usr/bin/env node

/**
 * Shared Context MCP Server
 *
 * Exposes LiveContext operations as MCP tools for inter-agent communication.
 * Agents can publish discoveries, read sibling findings, and claim file ownership.
 *
 * Tools:
 * - publish_discovery: Write a finding for other agents to see
 * - get_discoveries: Read recent discoveries from sibling agents
 * - claim_file: Claim ownership of a file to prevent conflicts
 * - check_file_claim: Check if a file is already claimed
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// In-memory store (populated via environment or init)
interface Discovery {
  id: string;
  agentId: string;
  taskId: string;
  type: string;
  summary: string;
  details: string;
  relatedFiles: string[];
  timestamp: string;
}

const discoveries: Discovery[] = [];
const fileClaims = new Map<string, string>();

const server = new McpServer(
  { name: 'orch-shared-context', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.tool(
  'publish_discovery',
  'Publish a discovery or finding for other agents to see. Use this to share conventions, patterns, decisions, or warnings.',
  {
    type: z.enum(['convention', 'pattern', 'decision', 'warning']).describe('Type of discovery'),
    summary: z.string().describe('Short summary of the discovery'),
    details: z.string().describe('Detailed explanation'),
    relatedFiles: z.array(z.string()).optional().describe('Files related to this discovery'),
  },
  async ({ type, summary, details, relatedFiles }) => {
    const agentId = process.env.ORCH_AGENT_ID ?? 'unknown';
    const taskId = process.env.ORCH_TASK_ID ?? 'unknown';

    const discovery: Discovery = {
      id: `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      taskId,
      type,
      summary,
      details,
      relatedFiles: relatedFiles ?? [],
      timestamp: new Date().toISOString(),
    };

    discoveries.push(discovery);

    return {
      content: [{ type: 'text' as const, text: `Discovery published: ${summary}` }],
    };
  },
);

server.tool(
  'get_discoveries',
  'Get recent discoveries published by sibling agents.',
  {
    type: z.enum(['all', 'convention', 'pattern', 'decision', 'warning']).optional().describe('Filter by type'),
  },
  async ({ type }) => {
    const filtered = type && type !== 'all'
      ? discoveries.filter((d) => d.type === type)
      : discoveries;

    if (filtered.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No discoveries found.' }],
      };
    }

    const formatted = filtered.map((d) =>
      `[${d.type}] ${d.summary} (by agent ${d.agentId})\n  ${d.details}` +
      (d.relatedFiles.length > 0 ? `\n  Files: ${d.relatedFiles.join(', ')}` : ''),
    ).join('\n\n');

    return {
      content: [{ type: 'text' as const, text: formatted }],
    };
  },
);

server.tool(
  'claim_file',
  'Claim ownership of a file to prevent conflicts with other agents. Returns whether the claim was successful.',
  {
    filePath: z.string().describe('Path to the file to claim'),
  },
  async ({ filePath }) => {
    const agentId = process.env.ORCH_AGENT_ID ?? 'unknown';
    const existing = fileClaims.get(filePath);

    if (existing && existing !== agentId) {
      return {
        content: [{
          type: 'text' as const,
          text: `CONFLICT: File ${filePath} is already claimed by agent ${existing}. You should coordinate before modifying it.`,
        }],
      };
    }

    fileClaims.set(filePath, agentId);
    return {
      content: [{ type: 'text' as const, text: `File claimed: ${filePath}` }],
    };
  },
);

server.tool(
  'check_file_claim',
  'Check if a file is claimed by another agent.',
  {
    filePath: z.string().describe('Path to check'),
  },
  async ({ filePath }) => {
    const claimedBy = fileClaims.get(filePath);
    if (claimedBy) {
      return {
        content: [{ type: 'text' as const, text: `File ${filePath} is claimed by agent ${claimedBy}.` }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: `File ${filePath} is not claimed.` }],
    };
  },
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
