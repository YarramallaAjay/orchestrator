import type { Db } from '../db/connection.js';
import type { EvalMetrics } from './types.js';
import { TaskRepository } from '../task/task-repository.js';
import { TaskGraph } from '../task/task-graph.js';
import { EventStore } from '../events/event-store.js';
import { TaskStatus } from '../task/types.js';

/**
 * Collects metrics from the database and event store after an orchestrator run.
 */
export class MetricsCollector {
  private taskRepo: TaskRepository;
  private eventStore: EventStore;

  constructor(
    private db: Db,
    eventStore?: EventStore,
  ) {
    this.taskRepo = new TaskRepository(db);
    this.eventStore = eventStore ?? new EventStore(db);
  }

  async collect(projectId: string, planStartTime: number, execStartTime: number): Promise<EvalMetrics> {
    const tasks = await this.taskRepo.findByProject(projectId);

    // Planning metrics
    const planningDurationMs = execStartTime - planStartTime;
    const tasksPlanned = tasks.length;

    const tasksByClassification: Record<string, number> = {};
    for (const task of tasks) {
      tasksByClassification[task.classification] = (tasksByClassification[task.classification] ?? 0) + 1;
    }

    // Build task graph for dependency depth
    const graph = new TaskGraph();
    for (const task of tasks) {
      graph.addTask(task);
    }
    let dependencyDepth = 0;
    try {
      const critPath = graph.criticalPath();
      dependencyDepth = critPath.length;
    } catch {
      dependencyDepth = 0;
    }

    // Execution metrics
    const now = Date.now();
    const executionDurationMs = now - execStartTime;
    const tasksCompleted = tasks.filter((t) => t.status === TaskStatus.COMPLETED).length;
    const tasksFailed = tasks.filter((t) => t.status === TaskStatus.FAILED).length;
    const tasksCancelled = tasks.filter((t) => t.status === TaskStatus.CANCELLED).length;
    const tasksRetried = tasks.filter((t) => t.attempt > 0).length;
    const totalRetries = tasks.reduce((sum, t) => sum + t.attempt, 0);
    const avgRetriesPerFailedTask = tasksFailed > 0
      ? tasks.filter((t) => t.status === TaskStatus.FAILED).reduce((sum, t) => sum + t.attempt, 0) / tasksFailed
      : 0;

    // Validation metrics from events
    const eventCounts = await this.eventStore.countByType(projectId);
    const validationChecks = (eventCounts['validation.completed'] ?? 0) + (eventCounts['validation.failed'] ?? 0);
    const validationFailures = eventCounts['validation.failed'] ?? 0;
    const validationPassRate = validationChecks > 0
      ? (validationChecks - validationFailures) / validationChecks
      : 1;

    // Cost metrics from agent events
    const agentEvents = await this.eventStore.query({
      projectId,
      type: 'agent.status_changed',
      limit: 10000,
    });

    let totalCostUsd = 0;
    const costByAgent: Record<string, number> = {};
    let totalTurns = 0;
    const agentIds = new Set<string>();
    let maxConcurrent = 0;

    for (const event of agentEvents) {
      const payload = event.payload as any;
      if (payload.costUsd) {
        totalCostUsd += payload.costUsd;
        const agentId = payload.agentId ?? 'unknown';
        costByAgent[agentId] = (costByAgent[agentId] ?? 0) + payload.costUsd;
      }
      if (payload.turnsUsed) {
        totalTurns += payload.turnsUsed;
      }
      if (payload.agentId) {
        agentIds.add(payload.agentId);
      }
    }

    // Calculate concurrent agent count from running task snapshots
    const runningEvents = await this.eventStore.query({
      projectId,
      type: 'task.state_changed',
      limit: 10000,
    });

    let currentRunning = 0;
    for (const event of runningEvents) {
      const payload = event.payload as any;
      if (payload.to === TaskStatus.RUNNING) {
        currentRunning++;
        maxConcurrent = Math.max(maxConcurrent, currentRunning);
      } else if (
        payload.from === TaskStatus.RUNNING &&
        (payload.to === TaskStatus.COMPLETED || payload.to === TaskStatus.FAILED)
      ) {
        currentRunning = Math.max(0, currentRunning - 1);
      }
    }

    const costPerTask = tasksPlanned > 0 ? totalCostUsd / tasksPlanned : 0;
    const costPerSuccessfulTask = tasksCompleted > 0 ? totalCostUsd / tasksCompleted : 0;

    // Timing metrics
    const totalDurationMs = now - planStartTime;
    const taskDurations = tasks
      .filter((t) => t.startedAt && t.completedAt)
      .map((t) => new Date(t.completedAt!).getTime() - new Date(t.startedAt!).getTime());

    const avgTaskDurationMs = taskDurations.length > 0
      ? taskDurations.reduce((a, b) => a + b, 0) / taskDurations.length
      : 0;
    const longestTaskMs = taskDurations.length > 0 ? Math.max(...taskDurations) : 0;
    const shortestTaskMs = taskDurations.length > 0 ? Math.min(...taskDurations) : 0;

    const agentsUsed = agentIds.size || new Set(tasks.map((t) => t.assignedAgentId).filter(Boolean)).size;
    const avgTurnsPerTask = tasksPlanned > 0 ? totalTurns / tasksPlanned : 0;
    const maxConcurrentAgents = maxConcurrent || 1;

    return {
      planningDurationMs,
      tasksPlanned,
      tasksByClassification,
      dependencyDepth,
      executionDurationMs,
      tasksCompleted,
      tasksFailed,
      tasksCancelled,
      tasksRetried,
      totalRetries,
      avgRetriesPerFailedTask,
      validationPassRate,
      validationChecks,
      validationFailures,
      totalCostUsd,
      costPerTask,
      costPerSuccessfulTask,
      costByAgent,
      totalDurationMs,
      avgTaskDurationMs,
      longestTaskMs,
      shortestTaskMs,
      agentsUsed,
      avgTurnsPerTask,
      maxConcurrentAgents,
    };
  }
}
