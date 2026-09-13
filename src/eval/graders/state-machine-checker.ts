import { TaskStatus, VALID_TRANSITIONS } from '../../task/types.js';

export interface StateTransition {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  timestamp: string;
}

export interface StateMachineCheckResult {
  valid: boolean;
  invalidTransitions: Array<{
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    reason: string;
  }>;
  totalTransitions: number;
}

/**
 * Validates that all task state transitions follow the allowed state machine.
 */
export function checkStateTransitions(transitions: StateTransition[]): StateMachineCheckResult {
  const result: StateMachineCheckResult = {
    valid: true,
    invalidTransitions: [],
    totalTransitions: transitions.length,
  };

  for (const t of transitions) {
    const allowed = VALID_TRANSITIONS[t.from];
    if (!allowed || !allowed.includes(t.to)) {
      result.valid = false;
      result.invalidTransitions.push({
        taskId: t.taskId,
        from: t.from,
        to: t.to,
        reason: `Transition from ${t.from} to ${t.to} is not allowed. Valid transitions from ${t.from}: ${(allowed ?? []).join(', ')}`,
      });
    }
  }

  return result;
}
