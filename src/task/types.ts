export enum TaskStatus {
  PENDING = 'PENDING',
  READY = 'READY',
  RUNNING = 'RUNNING',
  BLOCKED = 'BLOCKED',
  WAITING_FOR_HUMAN = 'WAITING_FOR_HUMAN',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum TaskClassification {
  LOCAL = 'LOCAL',
  MODULE = 'MODULE',
  CROSS_MODULE = 'CROSS_MODULE',
  AGENT = 'AGENT',
  HUMAN_IN_THE_LOOP = 'HUMAN_IN_THE_LOOP',
  AUTONOMOUS = 'AUTONOMOUS',
}

export type EffortEstimate = 'trivial' | 'small' | 'medium' | 'large' | 'xlarge';

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  classification: TaskClassification;
  priority: number;
  dependsOn: string[];
  assignedAgentId: string | null;
  worktreeId: string | null;
  attempt: number;
  maxRetries: number;
  inputContext: Record<string, unknown>;
  outputArtifacts: Record<string, unknown>;
  acceptanceCriteria: string[];
  validationScript: string | null;
  tags: string[];
  targetFiles: string[];
  estimatedEffort: EffortEstimate | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type DependencyType = 'BLOCKS' | 'SOFT';

export interface TaskDependency {
  taskId: string;
  dependsOnTaskId: string;
  type: DependencyType;
}

export interface CreateTaskInput {
  projectId: string;
  parentId?: string;
  title: string;
  description: string;
  classification?: TaskClassification;
  priority?: number;
  dependsOn?: string[];
  inputContext?: Record<string, unknown>;
  acceptanceCriteria?: string[];
  validationScript?: string;
  tags?: string[];
  targetFiles?: string[];
  estimatedEffort?: EffortEstimate;
  maxRetries?: number;
}

/**
 * Valid state transitions for tasks.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.PENDING]: [TaskStatus.READY, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
  [TaskStatus.READY]: [TaskStatus.RUNNING, TaskStatus.BLOCKED, TaskStatus.CANCELLED],
  [TaskStatus.RUNNING]: [
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.WAITING_FOR_HUMAN,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.BLOCKED]: [TaskStatus.READY, TaskStatus.CANCELLED],
  [TaskStatus.WAITING_FOR_HUMAN]: [TaskStatus.RUNNING, TaskStatus.CANCELLED],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.FAILED]: [TaskStatus.READY, TaskStatus.CANCELLED],
  [TaskStatus.CANCELLED]: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return status === TaskStatus.COMPLETED || status === TaskStatus.CANCELLED;
}
