import { TaskRepository } from '../task/task-repository.js';
import { TaskGraph } from '../task/task-graph.js';
import { TaskStatus, type Task, type CreateTaskInput } from '../task/types.js';
import type { AgentConfig } from '../agent/types.js';
import type { AgentRuntime } from '../agent/runtimes/runtime.js';
import { Executor } from './executor.js';
import { Scheduler, type SchedulerConfig } from './scheduler.js';
import { Planner } from './planner.js';
import { Validator } from './validator.js';
import { SessionManager, type SessionState, type TaskExecutionMetrics } from './session-manager.js';
import { EventBus } from '../events/event-bus.js';
import { EventStore } from '../events/event-store.js';
import { ContextStore } from '../context/context-store.js';
import { ContextCategory } from '../context/types.js';
import { ProjectScanner } from '../context/project-scanner.js';
import { ArtifactExtractor, type ExtractedArtifact } from './artifact-extractor.js';
import { ConflictDetector } from './conflict-detector.js';
import { ObservationStore } from '../context/observation-store.js';
import { SessionAnalytics } from './session-analytics.js';
import { generateId } from '../util/id.js';
import { logger } from '../util/logger.js';
import { orchestratorSessions, taskMetrics } from '../db/schema.js';
import type { ProjectConfig } from '../config/types.js';
import type { Db } from '../db/connection.js';
import { WorktreeManager, type WorktreeInfo } from '../git/worktree-manager.js';
import { MergeCoordinator } from '../git/merge-coordinator.js';
import { McpRegistry } from '../mcp/mcp-registry.js';
import { DiscoveryAgent, type DiscoveryResult } from './discovery-agent.js';
import { LiveContext } from '../context/live-context.js';
import { SkillAssigner } from './skill-assigner.js';

export type OrchestratorStage = 'planning' | 'awaiting_approval' | 'scheduling' | 'executing' | 'validating' | 'completed';

export interface ProgressEvent {
  stage: OrchestratorStage;
  message: string;
  task?: Task;
  tasksCompleted: number;
  tasksFailed: number;
  tasksRemaining: number;
  totalCostUsd: number;
}

export interface OrchestratorMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  totalTurns: number;
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
  metrics: OrchestratorMetrics;
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
  worktreeManager?: WorktreeManager;
  mcpRegistry?: McpRegistry;
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
  private artifactExtractor: ArtifactExtractor;
  private conflictDetector: ConflictDetector;
  private observationStore: ObservationStore;
  private skillAssigner: SkillAssigner;
  private taskArtifacts = new Map<string, ExtractedArtifact[]>();
  private liveContext: LiveContext | null = null;
  private isRunning = false;
  private abortController: AbortController | null = null;

  // Per-orchestrate session tracking (set during orchestrate())
  private activeSession: SessionState | null = null;
  private activeSessionManager: SessionManager | null = null;
  private activeSessionId: string | null = null;

  constructor(private deps: OrchestratorDeps) {
    this.taskGraph = new TaskGraph();
    this.scheduler = new Scheduler();
    this.executor = new Executor(deps.runtimes, deps.eventBus);
    this.validator = new Validator();
    this.artifactExtractor = new ArtifactExtractor();
    this.conflictDetector = new ConflictDetector();
    this.observationStore = new ObservationStore(deps.db);
    this.skillAssigner = new SkillAssigner(deps.mcpRegistry);

    // Use the first available runtime for the planner
    const plannerRuntime = deps.runtimes.values().next().value;
    if (!plannerRuntime) {
      throw new Error('At least one agent runtime must be registered');
    }
    this.planner = new Planner(plannerRuntime, {
      projectId: deps.projectId,
      model: 'claude-sonnet-4-6',
      sessionAnalytics: new SessionAnalytics(deps.db),
    });

    // Attach event store
    deps.eventStore.attach(deps.eventBus);
  }

  /**
   * Plan: decompose requirements into tasks.
   */
  async plan(requirements: string, discoveryContext?: string): Promise<Task[]> {
    logger.info('Starting requirement decomposition');

    const taskInputs = await this.planner.decompose(requirements, discoveryContext);

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
    onTaskComplete?: (task: Task, metrics: TaskExecutionMetrics) => void;
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
   * Orchestrate: full pipeline from requirements to results.
   * Plans tasks, optionally waits for approval, then executes autonomously.
   */
  async orchestrate(
    requirements: string,
    options: {
      maxConcurrent?: number;
      onProgress?: (event: ProgressEvent) => void;
      onPlanReady?: (tasks: Task[]) => Promise<boolean>;
    } = {},
  ): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const sessionManager = new SessionManager(this.deps.rootPath);
    const session = sessionManager.create(this.deps.projectId);
    this.activeSession = session;
    this.activeSessionManager = sessionManager;
    this.activeSessionId = session.sessionId;

    // Persist session to DB
    this.deps.db.insert(orchestratorSessions).values({
      id: session.sessionId,
      projectId: this.deps.projectId,
      requirements,
      status: 'running',
      startedAt: session.startedAt,
    }).run();

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
    const emptyMetrics: OrchestratorMetrics = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      totalTurns: 0,
    };

    try {
      // Create live context for inter-agent communication
      this.liveContext = new LiveContext(this.deps.contextStore, this.deps.projectId);

      // Phase 0a: Sync MCP server configs from project config
      if (this.deps.mcpRegistry && this.deps.config.mcp.servers.length > 0) {
        try {
          await this.deps.mcpRegistry.syncFromConfig(this.deps.config.mcp.servers);
          logger.info({ count: this.deps.config.mcp.servers.length }, 'MCP servers synced from config');
        } catch (err) {
          logger.warn({ err }, 'Failed to sync MCP server configs');
        }
      }

      // Phase 0b: Project context scan
      try {
        const scanner = new ProjectScanner();
        const scanResult = scanner.scan(this.deps.rootPath);
        const scanContext = scanner.formatAsContext(scanResult);
        await this.deps.contextStore.set({
          projectId: this.deps.projectId,
          key: 'project-scan',
          category: ContextCategory.ARCHITECTURE,
          title: 'Project Structure & Technology',
          content: scanContext,
          updatedBy: 'orchestrator:project-scanner',
        });
        logger.info({ name: scanResult.name, language: scanResult.language }, 'Project scanned');
      } catch (err) {
        logger.warn({ err }, 'Project scan failed, continuing without project context');
      }

      // Phase 0c: Discovery (deep codebase analysis)
      let planningRequirements = requirements;
      let discoveryContext: string | undefined;
      if (this.deps.config.discovery?.enabled !== false) {
        try {
          emitProgress('planning', 'Running discovery agent to analyze codebase...');
          const discoveryRuntime = this.deps.runtimes.values().next().value;
          if (discoveryRuntime) {
            const discoveryAgent = new DiscoveryAgent(discoveryRuntime, {
              enabled: true,
              model: this.deps.config.discovery?.model ?? 'claude-sonnet-4-6',
              maxTurns: this.deps.config.discovery?.maxTurns ?? 15,
            });

            const discoveryResult = await discoveryAgent.discover(requirements, {
              rootPath: this.deps.rootPath,
            });

            // Store discovery result in context store
            discoveryContext = DiscoveryAgent.formatForPlanner(discoveryResult);
            await this.deps.contextStore.set({
              projectId: this.deps.projectId,
              key: 'discovery-analysis',
              category: ContextCategory.ARCHITECTURE,
              title: 'Discovery Analysis',
              content: discoveryContext,
              updatedBy: 'orchestrator:discovery-agent',
            });

            // Use refined requirements for planning
            if (discoveryResult.refinedRequirements) {
              planningRequirements = discoveryResult.refinedRequirements;
            }

            logger.info({
              relevantFiles: discoveryResult.relevantFiles.length,
              patterns: discoveryResult.codePatterns.length,
            }, 'Discovery phase complete');
          }
        } catch (err) {
          logger.warn({ err }, 'Discovery phase failed, continuing with basic planning');
        }
      }

      // Phase 1: Planning
      emitProgress('planning', 'Decomposing requirements into tasks...');
      const planned = await this.plan(planningRequirements, discoveryContext);
      totalPlanned = planned.length;
      emitProgress('planning', `Planned ${totalPlanned} tasks`);

      // Phase 2: Plan approval (human-in-the-loop)
      if (options.onPlanReady) {
        emitProgress('awaiting_approval', `Awaiting approval for ${totalPlanned} tasks...`);
        const approved = await options.onPlanReady(planned);
        if (!approved) {
          session.status = 'completed';
          sessionManager.save(session);
          const durationMs = Date.now() - startTime;
          this.persistSessionToDb(session, durationMs, totalPlanned);
          return {
            success: false,
            tasks: planned,
            completedTasks: [],
            failedTasks: [],
            cancelledTasks: [],
            totalCostUsd: 0,
            durationMs,
            sessionId: session.sessionId,
            summary: 'Plan rejected by user',
            metrics: emptyMetrics,
          };
        }
      }

      // Phase 3: Execution (schedule → execute → validate → retry loop)
      emitProgress('executing', 'Starting execution...');

      await this.run({
        maxConcurrent: options.maxConcurrent,
        onTaskComplete: (task, taskMetricsData) => {
          sessionManager.markTaskCompleted(session, task.id, taskMetricsData);
          emitProgress('executing', `Completed: ${task.title}`, task);
        },
        onTaskFailed: (task, error) => {
          sessionManager.markTaskFailed(session, task.id);
          emitProgress('executing', `Failed: ${task.title} — ${error}`, task);
        },
      });

      // Phase 4: Results
      const allTasks = await this.deps.taskRepo.findByProject(this.deps.projectId);
      const completed = allTasks.filter((t) => t.status === TaskStatus.COMPLETED);
      const failed = allTasks.filter((t) => t.status === TaskStatus.FAILED);
      const cancelled = allTasks.filter((t) => t.status === TaskStatus.CANCELLED);
      const success = failed.length === 0 && cancelled.length === 0;

      sessionManager.complete(session);

      const durationMs = Date.now() - startTime;
      const metrics: OrchestratorMetrics = {
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalToolCalls: session.totalToolCalls,
        totalTurns: session.totalTurns,
      };

      const summary = `${completed.length}/${allTasks.length} tasks completed` +
        (failed.length > 0 ? `, ${failed.length} failed` : '') +
        (cancelled.length > 0 ? `, ${cancelled.length} cancelled` : '') +
        ` in ${(durationMs / 1000).toFixed(1)}s` +
        (session.totalCostUsd > 0 ? ` ($${session.totalCostUsd.toFixed(4)})` : '') +
        ` | ${session.totalInputTokens + session.totalOutputTokens} tokens, ${session.totalToolCalls} tool calls, ${session.totalTurns} turns`;

      // Check for file conflicts between tasks
      const conflictReport = this.conflictDetector.detect();
      if (conflictReport.hasConflicts) {
        const conflictSummary = conflictReport.conflicts
          .map((c) => `  ${c.taskIdA} <-> ${c.taskIdB}: ${c.sharedFiles.join(', ')}`)
          .join('\n');
        logger.warn({ conflicts: conflictReport.conflicts.length }, 'File conflicts detected between tasks');
        await this.deps.eventBus.publish({
          id: generateId('evt'),
          type: 'orchestrator.conflicts_detected',
          source: 'orchestrator',
          timestamp: new Date().toISOString(),
          projectId: this.deps.projectId,
          payload: { conflicts: conflictReport.conflicts, summary: conflictSummary },
        });
      }
      this.conflictDetector.reset();

      // Phase 5: Merge worktrees back into integration branch
      if (this.deps.worktreeManager && completed.length > 0) {
        try {
          const mergeCoordinator = new MergeCoordinator(this.deps.worktreeManager);
          const plan = await mergeCoordinator.planIntegration();
          if (plan.order.length > 0) {
            logger.info({ worktrees: plan.order.length }, 'Merging worktrees into integration branch');
            const mergeResults = await mergeCoordinator.executeIntegration(
              plan.order.map((wt) => wt.id),
              { stopOnConflict: false },
            );
            const mergeFailures = [...mergeResults.entries()].filter(([, r]) => !r.success);
            if (mergeFailures.length > 0) {
              logger.warn({ failures: mergeFailures.length }, 'Some worktree merges had conflicts');
            }
          }
          await this.deps.worktreeManager.cleanup();
        } catch (err) {
          logger.warn({ err }, 'Worktree merge/cleanup failed');
        }
      }

      emitProgress('completed', summary);
      this.persistSessionToDb(session, durationMs, totalPlanned);

      this.activeSession = null;
      this.activeSessionManager = null;
      this.activeSessionId = null;
      this.liveContext?.reset();
      this.liveContext = null;

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
        metrics,
      };
    } catch (error: any) {
      session.status = 'failed';
      sessionManager.save(session);

      const durationMs = Date.now() - startTime;
      this.persistSessionToDb(session, durationMs, totalPlanned);

      this.activeSession = null;
      this.activeSessionManager = null;
      this.activeSessionId = null;
      this.liveContext?.reset();
      this.liveContext = null;

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
        metrics: emptyMetrics,
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
      onTaskComplete?: (task: Task, metrics: TaskExecutionMetrics) => void;
      onTaskFailed?: (task: Task, error: string) => void;
    },
  ): Promise<void> {
    const taskStartTime = Date.now();
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

    // Build context (shared project context + upstream artifacts)
    const context = await this.deps.contextStore.buildAgentContext(
      this.deps.projectId,
      task,
    );

    // Build upstream artifact context from completed dependencies
    const upstreamContext = await this.buildUpstreamArtifactContext(task);

    // Include relevant observations from previous tasks
    let observationContext = '';
    try {
      const relevantObs = await this.observationStore.findRelevant(this.deps.projectId);
      observationContext = this.observationStore.formatForContext(relevantObs);
    } catch (err) {
      logger.warn({ err }, 'Failed to load observations');
    }

    // Include live context from sibling agents
    let liveContextSnapshot = '';
    if (this.liveContext) {
      liveContextSnapshot = this.liveContext.buildLiveContextSnapshot();
    }

    let fullContext: string | undefined = [context, upstreamContext, observationContext, liveContextSnapshot].filter(Boolean).join('\n\n') || undefined;

    // Create worktree for task isolation (if git repo)
    let executionCwd = this.deps.rootPath;
    let worktreeInfo: WorktreeInfo | null = null;
    if (this.deps.worktreeManager) {
      try {
        worktreeInfo = await this.deps.worktreeManager.create(task, agentConfig.id);
        executionCwd = worktreeInfo.path;
        await this.deps.taskRepo.update(task.id, { worktreeId: worktreeInfo.id });
        logger.info({ taskId: task.id, worktree: worktreeInfo.path, branch: worktreeInfo.branch }, 'Created worktree for task');
      } catch (err) {
        logger.warn({ taskId: task.id, err }, 'Failed to create worktree, using rootPath');
      }
    }

    // Assign skills based on task analysis
    const skillAssignment = this.skillAssigner.assignForTask(task, agentConfig);

    // Add skill guidance to context
    if (skillAssignment.guidance) {
      fullContext = [fullContext, skillAssignment.guidance].filter(Boolean).join('\n\n') || undefined;
    }

    // Resolve MCP servers for this agent (merge skill-assigned + agent-configured)
    let resolvedMcpServers: Record<string, unknown> | undefined;

    // Start with skill-assigned MCP servers
    if (Object.keys(skillAssignment.mcpServers).length > 0) {
      resolvedMcpServers = {};
      for (const [name, config] of Object.entries(skillAssignment.mcpServers)) {
        resolvedMcpServers[name] = {
          type: config.type ?? 'stdio',
          command: config.command,
          args: config.args,
          env: {
            ...config.env,
            ORCH_CWD: executionCwd,
          },
        };
      }
    }

    // Add agent-configured MCP servers from registry
    if (this.deps.mcpRegistry && agentConfig.mcpServers?.length) {
      if (!resolvedMcpServers) resolvedMcpServers = {};
      for (const serverName of agentConfig.mcpServers) {
        const serverConfig = await this.deps.mcpRegistry.getServer(serverName);
        if (serverConfig) {
          resolvedMcpServers[serverName] = {
            type: serverConfig.type ?? 'stdio',
            command: serverConfig.command,
            args: serverConfig.args,
            env: Object.keys(serverConfig.env).length > 0 ? serverConfig.env : undefined,
          };
        } else {
          logger.warn({ taskId: task.id, server: serverName }, 'MCP server not found in registry');
        }
      }
    }

    if (resolvedMcpServers && Object.keys(resolvedMcpServers).length === 0) {
      resolvedMcpServers = undefined;
    }

    const result = await this.executor.execute(task, agentConfig, {
      cwd: executionCwd,
      additionalContext: fullContext,
      mcpServers: resolvedMcpServers,
    });

    const taskDurationMs = Date.now() - taskStartTime;
    const execMetrics: TaskExecutionMetrics = {
      costUsd: result.totalCostUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls,
      turns: result.turnsUsed,
      durationMs: taskDurationMs,
    };

    // Validate
    if (this.deps.config.orchestrator.validationEnabled) {
      const validation = await this.validator.validate(task, result, executionCwd);

      if (!validation.passed) {
        // Persist task metrics for this attempt
        this.persistTaskMetrics(task, agentConfig.id, execMetrics, 'FAILED');

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
    this.persistTaskMetrics(task, agentConfig.id, execMetrics, 'COMPLETED');

    // Extract artifacts for downstream tasks
    const artifacts = this.artifactExtractor.extract(result);
    this.taskArtifacts.set(task.id, artifacts);

    // Register files for conflict detection
    this.conflictDetector.registerTaskFiles(task.id, result);

    // Extract and store observations for knowledge sharing
    try {
      const agentId = agentConfig.id;
      const extracted = this.observationStore.extractFromResult(result, {
        projectId: this.deps.projectId,
        taskId: task.id,
        agentId,
      });
      for (const obs of extracted) {
        await this.observationStore.add(obs);
      }
    } catch (err) {
      logger.warn({ err, taskId: task.id }, 'Failed to extract observations');
    }

    await this.deps.taskRepo.transition(task.id, TaskStatus.COMPLETED);
    await this.deps.taskRepo.update(task.id, {
      outputArtifacts: {
        ...result.outputArtifacts,
        _extractedArtifacts: artifacts,
      },
    });
    task.status = TaskStatus.COMPLETED;
    this.taskGraph.updateTask(task);
    options.onTaskComplete?.(task, execMetrics);

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

  private async buildUpstreamArtifactContext(task: Task): Promise<string> {
    const deps = await this.deps.taskRepo.getDependencies(task.id);
    if (deps.length === 0) return '';

    const sections: string[] = ['## Upstream Task Output\n'];

    for (const dep of deps) {
      const depTask = await this.deps.taskRepo.getById(dep.dependsOnTaskId);
      if (!depTask || depTask.status !== TaskStatus.COMPLETED) continue;

      const artifacts = this.taskArtifacts.get(depTask.id) ?? [];
      if (artifacts.length > 0) {
        sections.push(this.artifactExtractor.formatForDownstream(depTask.title, artifacts));
      }
    }

    return sections.length > 1 ? sections.join('\n') : '';
  }

  private persistTaskMetrics(
    task: Task,
    agentId: string,
    metrics: TaskExecutionMetrics,
    status: string,
  ): void {
    try {
      this.deps.db.insert(taskMetrics).values({
        id: generateId('tm'),
        sessionId: this.activeSessionId ?? '',
        projectId: this.deps.projectId,
        taskId: task.id,
        agentId,
        costUsd: metrics.costUsd,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        toolCalls: metrics.toolCalls,
        turns: metrics.turns,
        durationMs: metrics.durationMs,
        attempt: task.attempt,
        status,
        createdAt: new Date().toISOString(),
      }).run();
    } catch {
      // Don't let metrics persistence fail the task
    }
  }

  private persistSessionToDb(
    session: SessionState,
    durationMs: number,
    tasksPlanned: number,
  ): void {
    try {
      this.deps.db.update(orchestratorSessions).set({
        status: session.status,
        completedAt: new Date().toISOString(),
        tasksPlanned,
        tasksCompleted: session.completedTasks.length,
        tasksFailed: session.failedTasks.length,
        totalCostUsd: session.totalCostUsd,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalToolCalls: session.totalToolCalls,
        totalTurns: session.totalTurns,
        durationMs,
      }).run();
    } catch {
      // Don't let DB persistence fail the orchestration
    }
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
