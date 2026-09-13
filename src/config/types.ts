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
  env: z.record(z.string()).default({}),
  autoStart: z.boolean().default(false),
});

export const ProjectConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    rootPath: z.string().default('.'),
  }),
  orchestrator: z.object({
    maxConcurrentAgents: z.number().int().positive().default(3),
    maxTotalBudgetUsd: z.number().positive().default(10.0),
    autoRetry: z.boolean().default(true),
    maxRetries: z.number().int().nonnegative().default(2),
    validationEnabled: z.boolean().default(true),
  }).default({}),
  database: z.object({
    path: z.string().default('.orchestrator/data.db'),
  }).default({}),
  agents: z.object({
    templates: z.array(AgentTemplateConfigSchema).default([]),
  }).default({}),
  mcp: z.object({
    servers: z.array(McpServerConfigSchema).default([]),
  }).default({}),
  git: z.object({
    integrationBranch: z.string().default('main'),
    worktreeDir: z.string().default('.orchestrator/worktrees'),
    branchPrefix: z.string().default('orch/'),
  }).default({}),
  web: z.object({
    port: z.number().int().default(3847),
    host: z.string().default('localhost'),
  }).default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type AgentTemplateConfig = z.infer<typeof AgentTemplateConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type AgentCapabilityConfig = z.infer<typeof AgentCapabilitySchema>;
