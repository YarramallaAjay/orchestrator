#!/usr/bin/env node

/**
 * MCP Tools Server for `orch wrap` mode.
 *
 * Exposes orchestrator features as MCP tools that a wrapped Claude session can call.
 * Unlike the shared-context skill server (in-memory only), this server has DB access
 * for cross-session persistence via MemoryStore and ObservationStore.
 *
 * Tools:
 * - publish_observation: Share findings for future sessions
 * - get_observations: Read observations from current and past sessions
 * - store_memory: Persist cross-session knowledge
 * - recall_memory: Retrieve past knowledge
 * - get_project_context: Read the project context snapshot
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read config from environment
const projectId = process.env.ORCH_PROJECT_ID ?? '';
const dbPath = process.env.ORCH_DB_PATH ?? '';
const cwd = process.env.ORCH_CWD ?? process.cwd();

// Local state directory for inter-process communication
const stateDir = resolve(cwd, '.orchestrator', '.wrap-state');
mkdirSync(stateDir, { recursive: true });
const observationsFile = resolve(stateDir, 'observations.json');

// In-memory session observations (also written to disk for hook access)
interface SessionObservation {
  id: string;
  type: string;
  summary: string;
  details: string;
  relatedFiles: string[];
  timestamp: string;
}
let sessionObservations: SessionObservation[] = [];

// Load existing observations from disk
if (existsSync(observationsFile)) {
  try {
    sessionObservations = JSON.parse(readFileSync(observationsFile, 'utf-8'));
  } catch { /* start fresh */ }
}

function saveObservations(): void {
  writeFileSync(observationsFile, JSON.stringify(sessionObservations, null, 2));
}

// DB-backed stores (lazy initialized)
let db: any = null;
let memoryStore: any = null;

async function getDb() {
  if (db) return db;
  if (!dbPath) return null;
  try {
    const { createDb, initializeDb } = await import('../../db/connection.js');
    db = createDb(dbPath);
    initializeDb(db);
    return db;
  } catch {
    return null;
  }
}

async function getMemoryStore() {
  if (memoryStore) return memoryStore;
  const database = await getDb();
  if (!database) return null;
  try {
    const { MemoryStore } = await import('../../context/memory-store.js');
    memoryStore = new MemoryStore(database);
    return memoryStore;
  } catch {
    return null;
  }
}

// ── MCP Server ──────────────────────────────────────────

const server = new McpServer(
  { name: 'orch-tools', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.tool(
  'publish_observation',
  'Publish a discovery, convention, pattern, or warning for future sessions. Use this to share important findings.',
  {
    type: z.enum(['convention', 'pattern', 'decision', 'warning']).describe('Type of observation'),
    summary: z.string().describe('Short summary (1 sentence)'),
    details: z.string().describe('Detailed explanation'),
    relatedFiles: z.array(z.string()).optional().describe('Related file paths'),
  },
  async ({ type, summary, details, relatedFiles }) => {
    const observation: SessionObservation = {
      id: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      summary,
      details,
      relatedFiles: relatedFiles ?? [],
      timestamp: new Date().toISOString(),
    };

    sessionObservations.push(observation);
    saveObservations();

    // Also persist to DB if available
    const database = await getDb();
    if (database && projectId) {
      try {
        const { observations } = await import('../../db/schema.js');
        const { generateId } = await import('../../util/id.js');
        database.insert(observations).values({
          id: generateId('obs'),
          projectId,
          taskId: 'wrap-session',
          agentId: 'wrap-user',
          type,
          content: `${summary}: ${details}`,
          relevantFiles: JSON.stringify(relatedFiles ?? []),
          confidence: 0.8,
          createdAt: new Date().toISOString(),
        }).run();
      } catch { /* DB write failed, session observation still saved */ }
    }

    return {
      content: [{ type: 'text' as const, text: `Observation published: [${type}] ${summary}` }],
    };
  },
);

server.tool(
  'get_observations',
  'Get observations published during this session and from previous sessions.',
  {
    type: z.enum(['all', 'convention', 'pattern', 'decision', 'warning']).optional().describe('Filter by type'),
    includeHistory: z.boolean().optional().describe('Include observations from previous sessions (default: true)'),
  },
  async ({ type, includeHistory }) => {
    const parts: string[] = [];

    // Current session observations
    const current = type && type !== 'all'
      ? sessionObservations.filter((o) => o.type === type)
      : sessionObservations;

    if (current.length > 0) {
      parts.push('### Current Session');
      for (const o of current) {
        parts.push(`- [${o.type}] ${o.summary}: ${o.details}`);
      }
    }

    // Historical observations from DB
    if (includeHistory !== false && projectId) {
      const database = await getDb();
      if (database) {
        try {
          const { observations } = await import('../../db/schema.js');
          const { eq } = await import('drizzle-orm');
          const history = database
            .select()
            .from(observations)
            .where(eq(observations.projectId, projectId))
            .limit(20)
            .all();

          if (history.length > 0) {
            parts.push('\n### Previous Sessions');
            for (const o of history) {
              parts.push(`- [${o.type}] ${o.content}`);
            }
          }
        } catch { /* DB query failed */ }
      }
    }

    if (parts.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No observations found.' }] };
    }

    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

server.tool(
  'store_memory',
  'Persist important knowledge across sessions. Use this for conventions, decisions, or facts that should be remembered.',
  {
    category: z.enum(['convention', 'pattern', 'decision', 'preference', 'warning']).describe('Category'),
    key: z.string().describe('Short identifier for this memory (e.g., "auth-method")'),
    content: z.string().describe('The knowledge to remember'),
    confidence: z.number().min(0).max(1).optional().describe('Confidence level (0-1, default: 0.8)'),
  },
  async ({ category, key, content, confidence }) => {
    const store = await getMemoryStore();
    if (!store || !projectId) {
      return {
        content: [{ type: 'text' as const, text: 'Memory store unavailable. Observation saved locally instead.' }],
      };
    }

    const entry = await store.store({
      projectId,
      category,
      key,
      content,
      confidence: confidence ?? 0.8,
      source: 'wrap-session',
    });

    return {
      content: [{ type: 'text' as const, text: `Memory stored: [${category}] ${key} = ${content}` }],
    };
  },
);

server.tool(
  'recall_memory',
  'Retrieve knowledge from previous sessions. Search by category or keyword.',
  {
    category: z.enum(['convention', 'pattern', 'decision', 'preference', 'warning', 'all']).optional().describe('Filter by category'),
    query: z.string().optional().describe('Keyword to search for in memory content'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 10)'),
  },
  async ({ category, query, limit }) => {
    const store = await getMemoryStore();
    if (!store || !projectId) {
      return { content: [{ type: 'text' as const, text: 'Memory store unavailable.' }] };
    }

    const entries = await store.recall(projectId, {
      category: category === 'all' ? undefined : category,
      query: query ?? undefined,
      limit: limit ?? 10,
    });

    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No memories found.' }] };
    }

    const formatted = entries
      .map((e: any) => `- [${e.category}] **${e.key}**: ${e.content} (confidence: ${e.confidence})`)
      .join('\n');

    return { content: [{ type: 'text' as const, text: `## Recalled Memories\n\n${formatted}` }] };
  },
);

server.tool(
  'get_project_context',
  'Read the full project context snapshot (language, framework, dependencies, structure).',
  {},
  async () => {
    const contextFile = resolve(cwd, '.orchestrator', '.wrap-context.json');
    if (!existsSync(contextFile)) {
      return { content: [{ type: 'text' as const, text: 'No project context available.' }] };
    }

    try {
      const data = JSON.parse(readFileSync(contextFile, 'utf-8'));
      return { content: [{ type: 'text' as const, text: data.projectContext ?? 'No project context.' }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Failed to read project context.' }] };
    }
  },
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
