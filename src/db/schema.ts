import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── Projects ──────────────────────────────────────────────
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull(),
  configPath: text('config_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── Tasks ─────────────────────────────────────────────────
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  status: text('status').notNull().default('PENDING'),
  classification: text('classification').notNull().default('LOCAL'),
  priority: integer('priority').notNull().default(100),
  assignedAgentId: text('assigned_agent_id'),
  worktreeId: text('worktree_id'),
  attempt: integer('attempt').notNull().default(0),
  maxRetries: integer('max_retries').notNull().default(2),
  inputContext: text('input_context').notNull().default('{}'),
  outputArtifacts: text('output_artifacts').notNull().default('{}'),
  acceptanceCriteria: text('acceptance_criteria').notNull().default('[]'),
  validationScript: text('validation_script'),
  tags: text('tags').notNull().default('[]'),
  estimatedEffort: text('estimated_effort'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

// ── Task Dependencies ─────────────────────────────────────
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: text('depends_on_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('BLOCKS'),
  },
  (table) => ({
    taskDepUnique: uniqueIndex('task_dep_unique').on(table.taskId, table.dependsOnTaskId),
  }),
);

// ── Agent Templates ───────────────────────────────────────
export const agentTemplates = sqliteTable('agent_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  runtimeType: text('runtime_type').notNull(),
  capabilities: text('capabilities').notNull().default('[]'),
  model: text('model'),
  maxTurns: integer('max_turns'),
  maxBudgetUsd: real('max_budget_usd'),
  systemPrompt: text('system_prompt'),
  allowedTools: text('allowed_tools').notNull().default('[]'),
  permissionMode: text('permission_mode').default('default'),
  mcpServers: text('mcp_servers').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
});

// ── Agent Instances ───────────────────────────────────────
export const agentInstances = sqliteTable('agent_instances', {
  id: text('id').primaryKey(),
  templateId: text('template_id').notNull().references(() => agentTemplates.id),
  status: text('status').notNull().default('IDLE'),
  currentTaskId: text('current_task_id'),
  sessionId: text('session_id'),
  totalCostUsd: real('total_cost_usd').notNull().default(0),
  turnsUsed: integer('turns_used').notNull().default(0),
  createdAt: text('created_at').notNull(),
  lastActiveAt: text('last_active_at').notNull(),
});

// ── Shared Context ────────────────────────────────────────
export const contextEntries = sqliteTable(
  'context_entries',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id),
    key: text('key').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    ctxProjectKey: uniqueIndex('ctx_project_key').on(table.projectId, table.key),
  }),
);

// ── Context History ───────────────────────────────────────
export const contextHistory = sqliteTable('context_history', {
  id: text('id').primaryKey(),
  entryId: text('entry_id').notNull().references(() => contextEntries.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  updatedBy: text('updated_by').notNull(),
  createdAt: text('created_at').notNull(),
});

// ── Events ────────────────────────────────────────────────
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  source: text('source').notNull(),
  projectId: text('project_id').notNull(),
  payload: text('payload').notNull(),
  correlationId: text('correlation_id'),
  timestamp: text('timestamp').notNull(),
});

// ── Git Worktrees ─────────────────────────────────────────
export const worktrees = sqliteTable('worktrees', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  path: text('path').notNull(),
  branch: text('branch').notNull(),
  taskId: text('task_id'),
  agentId: text('agent_id'),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: text('created_at').notNull(),
  mergedAt: text('merged_at'),
});

// ── Eval Runs ────────────────────────────────────────────
export const evalRuns = sqliteTable('eval_runs', {
  id: text('id').primaryKey(),
  scenarioName: text('scenario_name').notNull(),
  projectId: text('project_id').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  status: text('status').notNull().default('running'),
  metrics: text('metrics'),
  config: text('config'),
  notes: text('notes'),
});

// ── MCP Server Registry ──────────────────────────────────
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  type: text('type').notNull(),
  command: text('command'),
  args: text('args').notNull().default('[]'),
  url: text('url'),
  env: text('env').notNull().default('{}'),
  autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
});
