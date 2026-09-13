import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, initializeDb } from '../db/connection.js';
import type { Db } from '../db/connection.js';
import { projects, evalRuns } from '../db/schema.js';
import { TaskRepository } from '../task/task-repository.js';
import { TaskGraph } from '../task/task-graph.js';
import { TaskStatus } from '../task/types.js';
import { EventBus } from '../events/event-bus.js';
import { EventStore } from '../events/event-store.js';
import { ContextStore } from '../context/context-store.js';
import { ContextRepository } from '../context/context-repository.js';
import { Orchestrator, type OrchestratorDeps } from '../core/orchestrator.js';
import { ClaudeCliRuntime } from '../agent/runtimes/claude-cli-runtime.js';
import { MetricsCollector } from './metrics-collector.js';
import { generateId } from '../util/id.js';
import { logger } from '../util/logger.js';
import type { EvalScenario, EvalResult, EvalCheckResult, EvalMetrics } from './types.js';
import type { AgentRuntime } from '../agent/runtimes/runtime.js';
import type { ProjectConfig } from '../config/types.js';

export interface EvalRunnerOptions {
  dryRun?: boolean;
  db?: Db;
  projectConfig?: ProjectConfig;
}

const DEFAULT_CONFIG: ProjectConfig = {
  project: { name: 'eval-project', rootPath: '.' },
  orchestrator: {
    maxConcurrentAgents: 1,
    maxTotalBudgetUsd: 10.0,
    autoRetry: true,
    maxRetries: 2,
    validationEnabled: true,
  },
  database: { path: '.orchestrator/data.db' },
  agents: { templates: [] },
  mcp: { servers: [] },
  git: { integrationBranch: 'main', worktreeDir: '.orchestrator/worktrees', branchPrefix: 'orch/' },
  web: { port: 3847, host: 'localhost' },
};

/**
 * Runs eval scenarios against the orchestrator and collects results.
 */
export class EvalRunner {
  constructor(private options: EvalRunnerOptions = {}) {}

  async runScenario(scenario: EvalScenario): Promise<EvalResult> {
    const runId = generateId('eval');
    const resultsDb = this.options.db;

    // Record eval run start
    if (resultsDb) {
      resultsDb.insert(evalRuns).values({
        id: runId,
        scenarioName: scenario.name,
        projectId: '',
        startedAt: new Date().toISOString(),
        status: 'running',
      }).run();
    }

    // Create temp directory for eval
    const tempDir = join(tmpdir(), `orch-eval-${runId}`);
    mkdirSync(tempDir, { recursive: true });

    let evalDb: Db | undefined;

    try {
      // Set up isolated DB
      const dbPath = join(tempDir, 'eval.db');
      evalDb = createDb(dbPath);
      initializeDb(evalDb);

      // Create project record
      const projectId = generateId('proj');
      evalDb.insert(projects).values({
        id: projectId,
        name: `eval-${scenario.name}`,
        rootPath: tempDir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();

      // Set up deps
      const eventBus = new EventBus();
      const eventStore = new EventStore(evalDb);
      eventStore.attach(eventBus);

      const taskRepo = new TaskRepository(evalDb);
      const contextStore = new ContextStore(new ContextRepository(evalDb));

      const cliRuntime = new ClaudeCliRuntime();
      const runtimes = new Map<string, AgentRuntime>([
        ['claude-cli', cliRuntime],
      ]);

      const config = this.options.projectConfig ?? DEFAULT_CONFIG;
      config.orchestrator.maxTotalBudgetUsd = scenario.maxBudgetUsd;

      const deps: OrchestratorDeps = {
        db: evalDb,
        config,
        projectId,
        rootPath: tempDir,
        runtimes,
        eventBus,
        eventStore,
        contextStore,
        taskRepo,
      };

      const orchestrator = new Orchestrator(deps);
      const metricsCollector = new MetricsCollector(evalDb, eventStore);

      // Phase 1: Plan
      const planStart = Date.now();
      const plannedTasks = await orchestrator.plan(scenario.requirements);
      const planEnd = Date.now();

      if (this.options.dryRun) {
        // Collect planning-only metrics
        const metrics = await metricsCollector.collect(projectId, planStart, planEnd);
        const checks = this.runChecks(scenario, metrics, plannedTasks.length);
        const status = checks.every((c) => c.passed) ? 'passed' : 'failed';

        const result: EvalResult = {
          scenario: scenario.name,
          status,
          metrics,
          checks,
          runId,
        };

        this.persistResult(resultsDb, runId, result, config);
        return result;
      }

      // Phase 2: Execute with timeout
      const execStart = Date.now();
      const timeoutPromise = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('Eval scenario timed out')), scenario.maxDurationMs);
      });

      try {
        await Promise.race([
          orchestrator.run({ maxConcurrent: config.orchestrator.maxConcurrentAgents }),
          timeoutPromise,
        ]);
      } catch (err: any) {
        if (err.message !== 'Eval scenario timed out') throw err;
        orchestrator.stop();
      }

      // Collect metrics
      const metrics = await metricsCollector.collect(projectId, planStart, execStart);
      const allTasks = await taskRepo.findByProject(projectId);
      const checks = this.runChecks(scenario, metrics, allTasks.length);
      const status = checks.every((c) => c.passed) ? 'passed' : 'failed';

      const result: EvalResult = {
        scenario: scenario.name,
        status,
        metrics,
        checks,
        runId,
      };

      this.persistResult(resultsDb, runId, result, config);
      eventStore.detach();
      return result;
    } catch (error: any) {
      logger.error({ error: error.message, scenario: scenario.name }, 'Eval scenario error');

      const result: EvalResult = {
        scenario: scenario.name,
        status: 'error',
        metrics: this.emptyMetrics(),
        checks: [],
        error: error.message,
        runId,
      };

      this.persistResult(resultsDb, runId, result);
      return result;
    } finally {
      // Clean up temp dir
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async runScenarios(scenarios: EvalScenario[]): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    for (const scenario of scenarios) {
      const result = await this.runScenario(scenario);
      results.push(result);
    }
    return results;
  }

  private runChecks(scenario: EvalScenario, metrics: EvalMetrics, taskCount: number): EvalCheckResult[] {
    const results: EvalCheckResult[] = [];

    for (const check of scenario.validationChecks) {
      switch (check.type) {
        case 'task_success_rate': {
          const rate = metrics.tasksPlanned > 0
            ? metrics.tasksCompleted / metrics.tasksPlanned
            : 0;
          const threshold = check.threshold ?? 0.8;
          results.push({
            name: check.name,
            passed: rate >= threshold,
            actual: parseFloat(rate.toFixed(4)),
            expected: threshold,
          });
          break;
        }
        case 'cost_under': {
          const threshold = check.threshold ?? 1.0;
          results.push({
            name: check.name,
            passed: metrics.totalCostUsd <= threshold,
            actual: parseFloat(metrics.totalCostUsd.toFixed(4)),
            expected: threshold,
          });
          break;
        }
        case 'retry_rate_under': {
          const retryRate = metrics.tasksPlanned > 0
            ? metrics.tasksRetried / metrics.tasksPlanned
            : 0;
          const threshold = check.threshold ?? 0.5;
          results.push({
            name: check.name,
            passed: retryRate <= threshold,
            actual: parseFloat(retryRate.toFixed(4)),
            expected: threshold,
          });
          break;
        }
        case 'all_tasks_completed': {
          if (scenario.expectedTaskCount) {
            const inRange = taskCount >= scenario.expectedTaskCount.min &&
              taskCount <= scenario.expectedTaskCount.max;
            results.push({
              name: check.name,
              passed: inRange,
              actual: taskCount,
              expected: scenario.expectedTaskCount.max,
            });
          } else {
            results.push({
              name: check.name,
              passed: metrics.tasksCompleted > 0,
              actual: metrics.tasksCompleted,
              expected: 1,
            });
          }
          break;
        }
        case 'custom': {
          // Custom checks pass by default in built-in mode
          results.push({
            name: check.name,
            passed: true,
            actual: 1,
            expected: 1,
          });
          break;
        }
      }
    }

    return results;
  }

  private persistResult(db: Db | undefined, runId: string, result: EvalResult, config?: ProjectConfig): void {
    if (!db) return;
    try {
      db.update(evalRuns).set({
        status: result.status,
        completedAt: new Date().toISOString(),
        metrics: JSON.stringify(result.metrics),
        config: config ? JSON.stringify(config) : null,
        notes: result.error ?? null,
      }).run();
    } catch {
      // Ignore persistence errors in eval
    }
  }

  private emptyMetrics(): EvalMetrics {
    return {
      planningDurationMs: 0,
      tasksPlanned: 0,
      tasksByClassification: {},
      dependencyDepth: 0,
      executionDurationMs: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksCancelled: 0,
      tasksRetried: 0,
      totalRetries: 0,
      avgRetriesPerFailedTask: 0,
      validationPassRate: 0,
      validationChecks: 0,
      validationFailures: 0,
      totalCostUsd: 0,
      costPerTask: 0,
      costPerSuccessfulTask: 0,
      costByAgent: {},
      totalDurationMs: 0,
      avgTaskDurationMs: 0,
      longestTaskMs: 0,
      shortestTaskMs: 0,
      agentsUsed: 0,
      avgTurnsPerTask: 0,
      maxConcurrentAgents: 0,
    };
  }
}
