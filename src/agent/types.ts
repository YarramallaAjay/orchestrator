export interface AgentCapability {
  name: string;
  level: 'basic' | 'proficient' | 'expert';
}

export type AgentRuntimeType = 'claude-sdk' | 'claude-cli' | 'api';

export type AgentPermissionMode = 'default' | 'auto' | 'acceptEdits';

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  runtimeType: AgentRuntimeType;
  capabilities: AgentCapability[];
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  allowedTools?: string[];
  permissionMode?: AgentPermissionMode;
  mcpServers?: string[];
  workingDirectory?: string;
  env?: Record<string, string>;
}

export enum AgentStatus {
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  WAITING = 'WAITING',
  ERROR = 'ERROR',
  TERMINATED = 'TERMINATED',
}

export interface AgentInstance {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  currentTaskId: string | null;
  sessionId: string | null;
  createdAt: string;
  lastActiveAt: string;
  totalCostUsd: number;
  turnsUsed: number;
}
