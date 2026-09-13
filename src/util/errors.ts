export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export class TaskError extends OrchestratorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TASK_ERROR', details);
    this.name = 'TaskError';
  }
}

export class TaskTransitionError extends OrchestratorError {
  constructor(taskId: string, from: string, to: string) {
    super(
      `Invalid task transition: ${from} -> ${to} for task ${taskId}`,
      'TASK_TRANSITION_ERROR',
      { taskId, from, to },
    );
    this.name = 'TaskTransitionError';
  }
}

export class AgentError extends OrchestratorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AGENT_ERROR', details);
    this.name = 'AgentError';
  }
}

export class ConfigError extends OrchestratorError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
  }
}

export class CycleDetectedError extends OrchestratorError {
  constructor(cycle: string[]) {
    super(
      `Dependency cycle detected: ${cycle.join(' -> ')}`,
      'CYCLE_DETECTED',
      { cycle },
    );
    this.name = 'CycleDetectedError';
  }
}
