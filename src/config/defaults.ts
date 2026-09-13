import type { ProjectConfig } from './types.js';

export const DEFAULT_CONFIG: ProjectConfig = {
  project: {
    name: 'untitled',
    rootPath: '.',
  },
  orchestrator: {
    maxConcurrentAgents: 3,
    maxTotalBudgetUsd: 10.0,
    autoRetry: true,
    maxRetries: 2,
    validationEnabled: true,
  },
  database: {
    path: '.orchestrator/data.db',
  },
  agents: {
    templates: [],
  },
  mcp: {
    servers: [],
  },
  git: {
    integrationBranch: 'main',
    worktreeDir: '.orchestrator/worktrees',
    branchPrefix: 'orch/',
  },
  web: {
    port: 3847,
    host: 'localhost',
  },
};

export const CONFIG_FILENAME = 'orchestrator.config.yaml';
export const ORCHESTRATOR_DIR = '.orchestrator';
