/**
 * Evaluation framework types for measuring orchestrator performance.
 */

export interface EvalScenario {
  name: string;
  description: string;
  requirements: string;
  expectedTaskCount?: { min: number; max: number };
  expectedClassifications?: Record<string, number>;
  maxBudgetUsd: number;
  maxDurationMs: number;
  validationChecks: EvalCheck[];
}

export interface EvalCheck {
  name: string;
  type: 'task_success_rate' | 'cost_under' | 'retry_rate_under' | 'all_tasks_completed' | 'custom';
  threshold?: number;
  customFn?: string;
}

export interface EvalMetrics {
  // Planning
  planningDurationMs: number;
  tasksPlanned: number;
  tasksByClassification: Record<string, number>;
  dependencyDepth: number;

  // Execution
  executionDurationMs: number;
  tasksCompleted: number;
  tasksFailed: number;
  tasksCancelled: number;
  tasksRetried: number;
  totalRetries: number;
  avgRetriesPerFailedTask: number;

  // Validation
  validationPassRate: number;
  validationChecks: number;
  validationFailures: number;

  // Cost
  totalCostUsd: number;
  costPerTask: number;
  costPerSuccessfulTask: number;
  costByAgent: Record<string, number>;

  // Timing
  totalDurationMs: number;
  avgTaskDurationMs: number;
  longestTaskMs: number;
  shortestTaskMs: number;

  // Agent
  agentsUsed: number;
  avgTurnsPerTask: number;
  maxConcurrentAgents: number;
}

export interface EvalCheckResult {
  name: string;
  passed: boolean;
  actual: number;
  expected: number;
}

export interface EvalResult {
  scenario: string;
  status: 'passed' | 'failed' | 'error';
  metrics: EvalMetrics;
  checks: EvalCheckResult[];
  error?: string;
  runId: string;
}
