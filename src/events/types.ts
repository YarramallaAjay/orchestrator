import type { TaskStatus } from '../task/types.js';

export interface OrchestratorEvent {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  projectId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

export interface TaskStateChangedEvent extends OrchestratorEvent {
  type: 'task.state_changed';
  payload: {
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    reason?: string;
  };
}

export interface TaskCreatedEvent extends OrchestratorEvent {
  type: 'task.created';
  payload: {
    taskId: string;
    title: string;
    projectId: string;
  };
}

export interface AgentMessageEvent extends OrchestratorEvent {
  type: 'agent.message';
  payload: {
    agentId: string;
    taskId: string;
    role: string;
    content: string;
  };
}

export interface AgentStatusChangedEvent extends OrchestratorEvent {
  type: 'agent.status_changed';
  payload: {
    agentId: string;
    from: string;
    to: string;
  };
}

export interface ContextUpdatedEvent extends OrchestratorEvent {
  type: 'context.updated';
  payload: {
    key: string;
    updatedBy: string;
    summary: string;
  };
}

export interface ValidationEvent extends OrchestratorEvent {
  type: 'validation.started' | 'validation.passed' | 'validation.failed';
  payload: {
    taskId: string;
    validationType: string;
    details?: string;
  };
}

export type SystemEvent =
  | TaskStateChangedEvent
  | TaskCreatedEvent
  | AgentMessageEvent
  | AgentStatusChangedEvent
  | ContextUpdatedEvent
  | ValidationEvent;
