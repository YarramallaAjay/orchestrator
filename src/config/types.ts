import { z } from 'zod';

const AgentCapabilitySchema = z.object({
  name: z.string(),
  level: z.enum(['basic', 'proficient', 'expert']),
});

const AgentTemplateConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  runtimeType: z.enum(['claude-sdk', 'claude-cli', 'api']),
  capabilities: z.array(AgentCapabilitySchema).default([]),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).default([]),
  permissionMode: z.enum(['default', 'auto', 'acceptEdits']).default('default'),
  mcpServers: z.array(z.string()).default([]),
});

const McpServerConfigSchema = z.object({
  name: z.string(),
  type: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  autoStart: z.boolean().default(false),
});

// Extract sub-schemas so we can compute their full defaults for zod v4
const OrchestratorSchema = z.object({
  maxConcurrentAgents: z.number().int().positive().default(3),
  maxTotalBudgetUsd: z.number().positive().default(10.0),
  autoRetry: z.boolean().default(true),
  maxRetries: z.number().int().nonnegative().default(2),
  validationEnabled: z.boolean().default(true),
});

const DatabaseSchema = z.object({
  path: z.string().default('.orchestrator/data.db'),
});

const AgentsSchema = z.object({
  templates: z.array(AgentTemplateConfigSchema).default([]),
});

const McpSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([]),
});

const DiscoverySchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().default('claude-sonnet-4-6'),
  maxTurns: z.number().int().positive().default(15),
});

const GitSchema = z.object({
  integrationBranch: z.string().default('main'),
  worktreeDir: z.string().default('.orchestrator/worktrees'),
  branchPrefix: z.string().default('orch/'),
});

const WebSchema = z.object({
  port: z.number().int().default(3847),
  host: z.string().default('localhost'),
});

export const ProjectConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    rootPath: z.string().default('.'),
  }),
  orchestrator: OrchestratorSchema.default(OrchestratorSchema.parse({})),
  database: DatabaseSchema.default(DatabaseSchema.parse({})),
  agents: AgentsSchema.default(AgentsSchema.parse({})),
  mcp: McpSchema.default(McpSchema.parse({})),
  discovery: DiscoverySchema.default(DiscoverySchema.parse({})),
  git: GitSchema.default(GitSchema.parse({})),
  web: WebSchema.default(WebSchema.parse({})),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type AgentTemplateConfig = z.infer<typeof AgentTemplateConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type AgentCapabilityConfig = z.infer<typeof AgentCapabilitySchema>;
export type DiscoveryConfig = z.infer<typeof DiscoverySchema>;
