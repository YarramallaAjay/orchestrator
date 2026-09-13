import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = ReturnType<typeof createDb>;

export function createDb(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  return db;
}

export function initializeDb(db: Db) {
  // Create tables directly via raw SQL since we're using push-style migrations
  // This is simpler than drizzle-kit for a CLI tool
  const sqlite = (db as any).session?.client as Database.Database | undefined;
  if (!sqlite) {
    throw new Error('Could not access underlying SQLite connection');
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      config_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      classification TEXT NOT NULL DEFAULT 'LOCAL',
      priority INTEGER NOT NULL DEFAULT 100,
      assigned_agent_id TEXT,
      worktree_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      input_context TEXT NOT NULL DEFAULT '{}',
      output_artifacts TEXT NOT NULL DEFAULT '{}',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      validation_script TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      estimated_effort TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'BLOCKS',
      UNIQUE(task_id, depends_on_task_id)
    );

    CREATE TABLE IF NOT EXISTS agent_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      model TEXT,
      max_turns INTEGER,
      max_budget_usd REAL,
      system_prompt TEXT,
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      permission_mode TEXT DEFAULT 'default',
      mcp_servers TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_instances (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL REFERENCES agent_templates(id),
      status TEXT NOT NULL DEFAULT 'IDLE',
      current_task_id TEXT,
      session_id TEXT,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      turns_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      key TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, key)
    );

    CREATE TABLE IF NOT EXISTS context_history (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES context_entries(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      project_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      correlation_id TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      task_id TEXT,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      merged_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      command TEXT,
      args TEXT NOT NULL DEFAULT '[]',
      url TEXT,
      env TEXT NOT NULL DEFAULT '{}',
      auto_start INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orchestrator_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      requirements TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      tasks_planned INTEGER NOT NULL DEFAULT 0,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      tasks_failed INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tool_calls INTEGER NOT NULL DEFAULT 0,
      total_turns INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS task_metrics (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      agent_id TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      scenario_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      metrics TEXT,
      config TEXT,
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);
    CREATE INDEX IF NOT EXISTS idx_events_project_type ON events(project_id, type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_eval_runs_started ON eval_runs(started_at);
  `);
}
