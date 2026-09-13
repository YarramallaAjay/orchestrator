import { TaskRepository } from '../task/task-repository.js';
import { TaskGraph } from '../task/task-graph.js';
import { TaskStatus, type Task, type CreateTaskInput } from '../task/types.js';
import type { AgentConfig } from '../agent/types.js';
import type { AgentRuntime } from '../agent/runtimes/runtime.js';
import { Executor } from './executor.js';
import { Scheduler, type SchedulerConfig } from './scheduler.js';
import { Planner } from './planner.js';
import { Validator } from './validator.js';
import { SessionManager, type SessionState } from './session-manager.js';
import { EventBus } from '../events/event-bus.js';
import { EventStore } from '../events/event-store.js';
import { ContextStore } from '../context/context-store.js';
import { generateId } from '../util/id.js';
import { logger } from '../util/logger.js';
import type { ProjectConfig } from '../config/types.js';
import type { Db } from '../db/connection.js';

export type OrchestratorStage = 'planning' | 'scheduling' | 'executing' | 'validating' | 'completed';

export interface ProgressEvent {
  stage: OrchestratorStage;
  message: string;
  task?: Task;
  tasksCompleted: number;
  tasksFailed: number;
  tasksRemaining: number;
  totalCostUsd: number;
}

export interface OrchestratorResult {
  success: boolean;
  tasks: Task[];
  completedTasks: Task[];
  failedTasks: Task[];
  cancelledTasks: Task[];
  totalCostUsd: number;
  durationMs: number;
  sessionId: string;
  summary: string;
}

export interface OrchestratorDeps {
  db: Db;
  config: ProjectConfig;
  projectId: string;
  rootPath: string;
  runtimes: Map<string, AgentRuntime>;
  eventBus: EventBus;
  eventStore: EventStore;
  contextStore: ContextStore;
  taskRepo: TaskRepository;
}

/**
 * Top-level control plane that coordinates task decomposition,
 * scheduling, execution, validation, and state management.
 */
export class Orchestrator {
  private taskGraph: TaskGraph;
  private scheduler: Scheduler;
  private executor: Executor;
  private planner: Planner;
  private validator: Validator;
  private isRunning = false;
  private abortController: AbortController | null = null;

  constructor(private deps: OrchestratorDeps) {
    this.taskGraph = new TaskGraph();
    this.scheduler = new Scheduler();
    this.executor = new Executor(deps.runtimes, deps.eventBus);
    this.validator = new Validator();

    // Use the first available runtime for the planner
    const plannerRuntime = deps.runtimes.values().next().value;
    if (!plannerRuntime) {
      throw new Error('At least one agent runtime must be registered');
    }
    this.planner = new Planner(plannerRuntime, {
      projectId: deps.projectId,
      model: 'claude-sonnet-4-6',
    });

    // Attach event store
    deps.eventStore.attach(deps.eventBus);
  }

  /**
   * Plan: decompose requirements into tasks.
   */
  async plan(requirements: string): Promise<Task[]> {
    logger.info('Starting requirement decomposition');

    const taskInputs = await this.planner.decompose(requirements);

    // Create tasks and resolve dependency references
    const created: Task[] = [];
    const tempIdToRealId = new Map<string, string>();

    // First pass: create all tasks without dependencies
    for (let i = 0; i < taskInputs.length; i++) {
      const input = { ...taskInputs[i]! };
      const tempDeps = input.dependsOn ?? [];
      input.dependsOn = []; // Create without deps first

      const task = await this.deps.taskRepo.create(input);
      created.push(task);
      tempIdToRealId.set(`__temp_${i}`, task.id);
    }

    // Second pass: add dependency edges
    for (let i = 0; i < taskInputs.length; i++) {
      const originalDeps = taskInputs[i]!.dependsOn ?? [];
      const task = created[i]!;

      for (const tempDep of originalDeps) {
        const realDepId = tempIdToRealId.get(tempDep);
        if (realDepId) {
          await this.deps.taskRepo.addDependency({
            taskId: task.id,
            dependsOnTaskId: realDepId,
            type: 'BLOCKS',
          });
          // Transition back to PENDING if it was set to READY
          if (task.status === TaskStatus.READY) {
            await this.deps.taskRepo.transition(task.id, TaskStatus.PENDING);
          }
        }
      }
    }

    // Reload all tasks with dependencies resolved
    const allTasks = await this.deps.taskRepo.findByProject(this.deps.projectId);

    // Build task graph
    for (const task of allTasks) {
      this.taskGraph.addTask(task);
    }

    // Detect cycles
    const cycle = this.taskGraph.detectCycle();
    if (cycle) {
      logger.error({ cycle }, 'Dependency cycle detected');
      throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }

    // Promote tasks with no unmet dependencies to READY
    await this.promoteReadyTasks();

    await this.deps.eventBus.publish({
      id: generateId('evt'),
      type: 'plan.completed',
      source: 'orchestrator',
      timestamp: new Date().toISOString(),
      projectId: this.deps.projectId,
      payload: { taskCount: created.length },
    });

    logger.info({ taskCount: created.length }, 'Planning complete');
    return created;
  }

  /**
   * Run: execute all ready tasks, respecting dependencies and concurrency.
   */
  async run(options: {
    maxConcurrent?: number;
    onTaskComplete?: (task: Task) => void;
    onTaskFailed?: (task: Task, error: string) => void;
  } = {}): Promise<void> {
    if (this.isRunning) {
      throw new Error('Orchestrator is already running');
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    const maxConcurrent = options.maxConcurrent ?? this.deps.config.orchestrator.maxConcurrentAgents;

    logger.info({ maxConcurrent }, 'Starting orchestration run');

    // Load task graph
    const allTasks = await this.deps.taskRepo.findByProject(this.deps.projectId);
    for (const task of allTasks) {
      this.taskGraph.addTask(task);
    }

    try {
      while (this.isRunning) {
        if (this.abortController.signal.aborted) break;

        // Get ready tasks
        const ready = await this.deps.taskRepo.findReady(this.deps.projectId);
        if (ready.length === 0) {
          // Check if there's still work in progress
          const running = await this.deps.taskRepo.findByStatus(
            this.deps.projectId,
            [TaskStatus.RUNNING],
          );
          const pending = await this.deps.taskRepo.findByStatus(
            this.deps.projectId,
            [TaskStatus.PENDING, TaskStatus.BLOCKED],
          );

          if (running.length === 0 && pending.length === 0) {
            logger.info('All tasks complete');
            break;
          }

          if (running.length === 0 && pending.length > 0) {
            logger.warn({ pending: pending.length }, 'Deadlock: pending tasks but none ready or running');
            break;
          }

          // Wait for running tasks to complete
          await this.deps.eventBus.waitFor(
            'task.state_changed',
            () => true,
            30_000,
          ).catch(() => {});
          continue;
        }

        // Schedule tasks
        const currentRunning = (await this.deps.taskRepo.findByStatus(
          this.deps.projectId,
          [TaskStatus.RUNNING],
        )).length;

        const schedulerConfig: SchedulerConfig = {
          maxConcurrent,
          currentRunning,
        };

        const assignments = this.scheduler.schedule(
          ready,
          this.deps.config.agents.templates.map((t) => ({
            ...t,
            capabilities: t.capabilities ?? [],
          })),
          schedulerConfig,
        );

        if (assignments.length === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        // Execute assignments
        if (maxConcurrent <= 1) {
          // Sequential execution
          for (const assignment of assignments) {
            if (this.abortController.signal.aborted) break;
            await this.executeTask(assignment.task, assignment.agent, options);
          }
        } else {
          // Parallel execution
          const promises = assignments.map((a) =>
            this.executeTask(a.task, a.agent, options),
          );
          await Promise.allSettled(promises);
        }
      }
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }

    logger.info('Orchestration run complete');
  }

  /**
   * Orchestrate: fully autonomous pipeline from requirements to results.
   * Plans, schedules, executes, validates, retries — no user intervention needed.
   */
  async orchestrate(
    requirements: string,
    options: {
      maxConcurrent?: number;
      onProgress?: (event: ProgressEvent) => void;
    } = {},
  ): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const sessionManager = new SessionManager(this.deps.rootPath);
    const session = sessionManager.create(this.deps.projectId);

    const emitProgress = (
      stage: OrchestratorStage,
      message: string,
      task?: Task,
    ) => {
      options.onProgress?.({
        stage,
        message,
        task,
        tasksCompleted: session.completedTasks.length,
        tasksFailed: session.failedTasks.length,
        tasksRemaining: Math.max(0, totalPlanned - session.completedTasks.length - session.failedTasks.length),
        totalCostUsd: session.totalCostUsd,
      });
    };

    let totalPlanned = 0;

    try {
      // Phase 1: Planning
      emitProgress('planning', 'Decomposing requirements into tasks...');
      const planned = await this.plan(requirements);
      totalPlanned = planned.length;
      emitProgress('planning', `Planned ${totalPlanned} tasks`);

      // Phase 2: Execution (schedule → execute → validate → retry loop)
      emitProgress('executing', 'Starting autonomous execution...');

      await this.run({
        maxConcurrent: options.maxConcurrent,
        onTaskComplete: (task) => {
          sessionManager.markTaskCompleted(session, task.id, 0);
          emitProgress('executing', `Completed: ${task.title}`, task);
        },
        onTaskFailed: (task, error) => {
          sessionManager.markTaskFailed(session, task.id);
          emitProgress('executing', `Failed: ${task.title} — ${error}`, task);
        },
      });

      // Phase 3: Results
      const allTasks = await this.deps.taskRepo.findByProject(this.deps.projectId);
      const completed = allTasks.filter((t) => t.status === TaskStatus.COMPLETED);
      const failed = allTasks.filter((t) => t.status === TaskStatus.FAILED);
      const cancelled = allTasks.filter((t) => t.status === TaskStatus.CANCELLED);
      const success = failed.length === 0 && cancelled.length === 0;

      sessionManager.complete(session);

      const durationMs = Date.now() - startTime;
      const summary = `${completed.length}/${allTasks.length} tasks completed` +
        (failed.length > 0 ? `, ${failed.length} failed` : '') +
        (cancelled.length > 0 ? `, ${cancelled.length} cancelled` : '') +
        ` in ${(durationMs / 1000).toFixed(1)}s` +
        (session.totalCostUsd > 0 ? ` ($${session.totalCostUsd.toFixed(4)})` : '');

      emitProgress('completed', summary);

      return {
        success,
        tasks: allTasks,
        completedTasks: completed,
        failedTasks: failed,
        cancelledTasks: cancelled,
        totalCostUsd: session.totalCostUsd,
        durationMs,
        sessionId: session.sessionId,
        summary,
      };
    } catch (error: any) {
      session.status = 'failed';
      sessionManager.save(session);

      const durationMs = Date.now() - startTime;
      return {
        success: false,
        tasks: [],
        completedTasks: [],
        failedTasks: [],
        cancelledTasks: [],
        totalCostUsd: session.totalCostUsd,
        durationMs,
        sessionId: session.sessionId,
        summary: `Orchestration failed: ${error.message}`,
      };
    }
  }

  /**
   * Stop the orchestration run.
   */
  stop(): void {
    this.isRunning = false;
    this.abortController?.abort();
  }

  private async executeTask(
    task: Task,
    agentConfig: AgentConfig,
    options: {
      onTaskComplete?: (task: Task) => void;
      onTaskFailed?: (task: Task, error: string) => void;
    },
  ): Promise<void> {
    logger.info({ taskId: task.id, agent: agentConfig.id }, 'Executing task');

    await this.deps.taskRepo.transition(task.id, TaskStatus.RUNNING);
    await this.deps.taskRepo.update(task.id, { assignedAgentId: agentConfig.id });

    await this.deps.eventBus.publish({
      id: generateId('evt'),
      type: 'task.state_changed',
      source: 'orchestrator',
      timestamp: new Date().toISOString(),
      projectId: this.deps.projectId,
      payload: { taskId: task.id, from: task.status, to: TaskStatus.RUNNING },
    });

    // Build context
    const context = await this.deps.contextStore.buildAgentContext(
      this.deps.projectId,
      task,
    );

    const result = await this.executor.execute(task, agentConfig, {
      cwd: this.deps.rootPath,
      additionalContext: context || undefined,
    });

    // Validate
    if (this.deps.config.orchestrator.validationEnabled) {
      const validation = await this.validator.validate(task, result, this.deps.rootPath);

      if (!validation.passed) {
        // Check retry
        if (this.deps.config.orchestrator.autoRetry && task.attempt < task.maxRetries) {
          logger.info({ taskId: task.id, attempt: task.attempt + 1 }, 'Retrying failed task');
          await this.deps.taskRepo.update(task.id, { attempt: task.attempt + 1 });
          await this.deps.taskRepo.transition(task.id, TaskStatus.FAILED);
          await this.deps.taskRepo.transition(task.id, TaskStatus.READY);

          // Update input context with feedback
          const feedback = this.validator.buildFeedback(task, validation);
          const updatedContext = { ...task.inputContext, _retryFeedback: feedback };
          await this.deps.taskRepo.update(task.id, { inputContext: updatedContext });
          return;
        }

        // Mark as failed
        await this.deps.taskRepo.transition(task.id, TaskStatus.FAILED);
        options.onTaskFailed?.(task, validation.checks.filter((c) => !c.passed).map((c) => c.output).join('; '));

        await this.deps.eventBus.publish({
          id: generateId('evt'),
          type: 'task.state_changed',
          source: 'orchestrator',
          timestamp: new Date().toISOString(),
          projectId: this.deps.projectId,
          payload: { taskId: task.id, from: TaskStatus.RUNNING, to: TaskStatus.FAILED },
        });
        return;
      }
    }

    // Success
    await this.deps.taskRepo.transition(task.id, TaskStatus.COMPLETED);
    await this.deps.taskRepo.update(task.id, { outputArtifacts: result.outputArtifacts });
    task.status = TaskStatus.COMPLETED;
    this.taskGraph.updateTask(task);
    options.onTaskComplete?.(task);

    await this.deps.eventBus.publish({
      id: generateId('evt'),
      type: 'task.state_changed',
      source: 'orchestrator',
      timestamp: new Date().toISOString(),
      projectId: this.deps.projectId,
      payload: { taskId: task.id, from: TaskStatus.RUNNING, to: TaskStatus.COMPLETED },
    });

    // Promote newly ready tasks
    await this.promoteReadyTasks();
  }

  private async promoteReadyTasks(): Promise<void> {
    const pending = await this.deps.taskRepo.findByStatus(
      this.deps.projectId,
      [TaskStatus.PENDING],
    );

    for (const task of pending) {
      const deps = await this.deps.taskRepo.getDependencies(task.id);
      const allMet = await Promise.all(
        deps.map(async (dep) => {
          const depTask = await this.deps.taskRepo.getById(dep.dependsOnTaskId);
          return depTask?.status === TaskStatus.COMPLETED;
        }),
      );

      if (allMet.every(Boolean)) {
        await this.deps.taskRepo.transition(task.id, TaskStatus.READY);
      }
    }
  }
}
