/**
 * Platform configuration schema.
 *
 * Loaded from platform.config.yaml (or orchestrator.config.yaml for backwards compat).
 */

import { z } from 'zod';

// ─── Agent Config ───────────────────────────────────────────────────────────

const MemorySubSchema = z.object({
  scope: z.enum(['global', 'project', 'workflow', 'agent']).default('agent'),
  access: z.enum(['read-only', 'read-write']).default('read-write'),
  subscribe: z.array(z.string()).default([]),
});

const PreferencesSubSchema = z.object({
  fallback_runtime: z.string().optional(),
  max_retries: z.number().int().nonnegative().default(2),
  timeout: z.string().default('300s'),
});

const TriggersSubSchema = z.object({
  on_event: z.string().optional(),
  on_schedule: z.string().optional(),
});

const AgentConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  runtime: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  memory: MemorySubSchema.default(MemorySubSchema.parse({})),
  preferences: PreferencesSubSchema.default(PreferencesSubSchema.parse({})),
  instructions: z.string().optional(),
  system_prompt: z.string().optional(),
  model: z.string().optional(),
  max_turns: z.number().int().positive().optional(),
  max_budget_usd: z.number().positive().optional(),
  allowed_tools: z.array(z.string()).default([]),
  permission_mode: z.enum(['default', 'auto', 'acceptEdits']).default('default'),
  triggers: TriggersSubSchema.default(TriggersSubSchema.parse({})),
});

// ─── Runtime Preference ─────────────────────────────────────────────────────

const RuntimePreferenceSchema = z.object({
  name: z.string(),
  type: z.string(),
  priority: z.number().int().default(0),
  capabilities: z.array(z.string()).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
});

// ─── Platform Config ────────────────────────────────────────────────────────

const ProjectSchema = z.object({
  name: z.string(),
  root_path: z.string().default('.'),
});

const ExecutionSchema = z.object({
  max_concurrent: z.number().int().positive().default(3),
  max_budget_usd: z.number().positive().default(10.0),
  auto_retry: z.boolean().default(true),
  max_retries: z.number().int().nonnegative().default(2),
});

const MemorySchema = z.object({
  kv_backend: z.enum(['memory', 'sqlite']).default('memory'),
  doc_backend: z.enum(['sqlite']).default('sqlite'),
});

const DatabaseSchema = z.object({
  path: z.string().default('.orchestrator/data.db'),
});

const GitSchema = z.object({
  integration_branch: z.string().default('main'),
  worktree_dir: z.string().default('.orchestrator/worktrees'),
  branch_prefix: z.string().default('orch/'),
});

const WebSchema = z.object({
  port: z.number().int().default(3847),
  host: z.string().default('localhost'),
});

export const PlatformConfigSchema = z.object({
  project: ProjectSchema,
  execution: ExecutionSchema.default(ExecutionSchema.parse({})),
  memory: MemorySchema.default(MemorySchema.parse({})),
  database: DatabaseSchema.default(DatabaseSchema.parse({})),
  git: GitSchema.default(GitSchema.parse({})),
  web: WebSchema.default(WebSchema.parse({})),
  agents: z.array(AgentConfigSchema).default([]),
  runtimes: z.array(RuntimePreferenceSchema).default([]),
  middleware: z.array(z.string()).default([]),
  plugins: z.array(z.string()).default([]),
});

export type PlatformConfig = z.infer<typeof PlatformConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type RuntimePreference = z.infer<typeof RuntimePreferenceSchema>;
