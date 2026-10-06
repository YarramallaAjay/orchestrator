/**
 * Agent definition parsers.
 *
 * Parses agent definitions from multiple sources:
 * - YAML (agent.yaml files)
 * - Markdown (.md files with frontmatter)
 *
 * Converts all formats into the unified AgentDefinition type.
 */

import { readFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AgentDefinition, AgentStep } from '../../platform/types.js';
import { Scope, AgentSource } from '../../platform/types.js';

// ─── YAML Agent Schema ──────────────────────────────────────────────────────

const AgentYamlSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  runtime: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  memory: z.object({
    scope: z.enum(['global', 'project', 'workflow', 'agent']).default('agent'),
    access: z.enum(['read-only', 'read-write']).default('read-write'),
    subscribe: z.array(z.string()).optional(),
  }).default({ scope: 'agent', access: 'read-write' }),
  preferences: z.object({
    max_retries: z.number().default(2),
    timeout: z.string().default('300s'),
    fallback_runtime: z.string().optional(),
  }).default({ max_retries: 2, timeout: '300s' }),
  instructions: z.string().optional(),
  steps: z.array(z.object({
    name: z.string(),
    description: z.string(),
    runtime: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
  })).optional(),
  triggers: z.object({
    on_event: z.string().optional(),
    on_schedule: z.string().optional(),
  }).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

type AgentYaml = z.infer<typeof AgentYamlSchema>;

// ─── Markdown Frontmatter Regex ──────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

// ─── Parsers ────────────────────────────────────────────────────────────────

/**
 * Parse a YAML agent config object into an AgentDefinition.
 */
export function parseYamlAgent(raw: Record<string, unknown>): AgentDefinition {
  const parsed = AgentYamlSchema.parse(raw);
  return yamlToDefinition(parsed);
}

/**
 * Parse a markdown agent file content into an AgentDefinition.
 *
 * Format:
 * ```
 * ---
 * name: my-agent
 * runtime: claude-code
 * capabilities: [file-edit, shell]
 * ---
 *
 * # Agent Instructions
 *
 * Do the thing...
 *
 * ## Steps
 *
 * 1. **Step Name**: Description of step
 * 2. **Step Name**: Description of step
 * ```
 */
export function parseMarkdownAgent(content: string): AgentDefinition {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error('Invalid markdown agent: missing frontmatter (---) block');
  }

  const [, frontmatterStr, bodyStr] = match;
  if (!frontmatterStr || !bodyStr) {
    throw new Error('Invalid markdown agent: empty frontmatter or body');
  }

  // Parse YAML frontmatter (simple key: value parsing)
  const frontmatter = parseSimpleYaml(frontmatterStr);
  const parsed = AgentYamlSchema.parse(frontmatter);

  const definition = yamlToDefinition(parsed);
  definition.source = AgentSource.DESCRIPTIVE;

  // Use the markdown body as instructions
  definition.instructions = bodyStr.trim();

  // Extract steps from markdown ## Steps section
  const steps = extractStepsFromMarkdown(bodyStr);
  if (steps.length > 0) {
    definition.steps = steps;
  }

  return definition;
}

/**
 * Load an agent definition from a file path.
 * Supports .yaml, .yml, and .md files.
 */
export async function loadAgentFile(filePath: string): Promise<AgentDefinition> {
  const content = await readFile(filePath, 'utf-8');

  if (filePath.endsWith('.md')) {
    return parseMarkdownAgent(content);
  }

  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    // Dynamic YAML import since it's optional
    const yaml = await import('yaml');
    const raw = yaml.parse(content);
    return parseYamlAgent(raw);
  }

  throw new Error(`Unsupported agent file format: ${filePath}`);
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function yamlToDefinition(parsed: AgentYaml): AgentDefinition {
  const scopeMap: Record<string, Scope> = {
    global: Scope.GLOBAL,
    project: Scope.PROJECT,
    workflow: Scope.WORKFLOW,
    agent: Scope.AGENT,
  };

  const steps: AgentStep[] | undefined = parsed.steps?.map((s) => ({
    name: s.name,
    description: s.description,
    runtime: s.runtime,
    dependsOn: s.depends_on,
  }));

  return {
    id: `agent_${nanoid(8)}`,
    name: parsed.name,
    description: parsed.description,
    source: AgentSource.YAML,
    runtime: parsed.runtime,
    capabilities: parsed.capabilities,
    memory: {
      scope: scopeMap[parsed.memory.scope] ?? Scope.AGENT,
      access: parsed.memory.access,
      subscribe: parsed.memory.subscribe,
    },
    preferences: {
      maxRetries: parsed.preferences.max_retries,
      timeoutMs: parseTimeout(parsed.preferences.timeout),
      fallbackRuntime: parsed.preferences.fallback_runtime,
    },
    instructions: parsed.instructions,
    steps,
    triggers: parsed.triggers ? {
      onEvent: parsed.triggers.on_event,
      onSchedule: parsed.triggers.on_schedule,
    } : undefined,
    adapterConfig: parsed.config,
  };
}

function parseTimeout(timeout: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(timeout);
  if (!match || !match[1] || !match[2]) {
    return 300_000; // default 5 min
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: return 300_000;
  }
}

/**
 * Simple YAML parser for frontmatter (handles basic key: value and arrays).
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of yaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim();
    let value: unknown = trimmed.substring(colonIdx + 1).trim();

    // Parse inline arrays: [a, b, c]
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (value === 'true') {
      value = true;
    } else if (value === 'false') {
      value = false;
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Extract structured steps from a markdown ## Steps section.
 */
function extractStepsFromMarkdown(body: string): AgentStep[] {
  const stepsSection = body.match(/## Steps\s*\n([\s\S]*?)(?=\n## |\n$|$)/i);
  if (!stepsSection?.[1]) return [];

  const steps: AgentStep[] = [];
  const stepLines = stepsSection[1].split('\n');

  for (const line of stepLines) {
    // Match numbered steps: "1. **Name**: Description"
    const stepMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*:\s*(.+)/);
    if (stepMatch && stepMatch[1] && stepMatch[2]) {
      steps.push({
        name: stepMatch[1].trim(),
        description: stepMatch[2].trim(),
      });
    }
  }

  return steps;
}
