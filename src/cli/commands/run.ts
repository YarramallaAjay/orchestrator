import { Command } from 'commander';
import chalk from 'chalk';
import { TaskRepository } from '../../task/task-repository.js';
import { TaskStatus } from '../../task/types.js';
import { ClaudeCliRuntime } from '../../agent/runtimes/claude-cli-runtime.js';
import { ClaudeSdkRuntime } from '../../agent/runtimes/claude-sdk-runtime.js';
import { Executor } from '../../core/executor.js';
import { Orchestrator, type OrchestratorDeps } from '../../core/orchestrator.js';
import { EventBus } from '../../events/event-bus.js';
import { EventStore } from '../../events/event-store.js';
import { ContextStore } from '../../context/context-store.js';
import { ContextRepository } from '../../context/context-repository.js';
import { loadProjectContext } from '../helpers.js';
import type { AgentConfig } from '../../agent/types.js';
import type { AgentRuntime } from '../../agent/runtimes/runtime.js';
import { WorktreeManager } from '../../git/worktree-manager.js';
import { isGitRepo } from '../../git/git-utils.js';
import { McpRegistry } from '../../mcp/mcp-registry.js';

export const runCommand = new Command('run')
  .description('Execute tasks')
  .option('-t, --task <id>', 'Run a specific task by ID')
  .option('--agent <id>', 'Agent template ID to use')
  .option('--model <model>', 'Override model for the agent')
  .option('--max-concurrent <n>', 'Maximum concurrent agents', '1')
  .option('--orchestrate', 'Use full orchestration loop (schedule -> execute -> validate -> promote)')
  .action(async (options) => {
    const ctx = loadProjectContext();
    const { db, projectId, config, rootPath } = ctx;
    const repo = new TaskRepository(db);
    const eventBus = new EventBus();

    // Set up runtimes
    const cliRuntime = new ClaudeCliRuntime();
    const sdkRuntime = new ClaudeSdkRuntime();
    const runtimes = new Map<string, AgentRuntime>([
      ['claude-sdk', sdkRuntime],
      ['claude-cli', cliRuntime],
    ]);

    // Subscribe to agent messages for live output
    eventBus.subscribe('agent.message', (event) => {
      const { content, role, toolUse } = event.payload as any;
      if (toolUse) {
        console.log(chalk.dim(`  [${toolUse.name}]`));
      } else if (role === 'assistant' && content) {
        console.log(chalk.white(`  ${content}`));
      }
    });

    // Build default agent config
    function getAgentConfig(): AgentConfig {
      if (options.agent) {
        const template = config.agents.templates.find((t) => t.id === options.agent);
        if (!template) {
          console.error(chalk.red(`Agent template not found: ${options.agent}`));
          process.exit(1);
        }
        return { ...template, capabilities: template.capabilities ?? [] };
      }
      return {
        id: 'default',
        name: 'Default Agent',
        role: 'developer',
        runtimeType: 'claude-cli',
        capabilities: [],
        model: options.model ?? 'claude-sonnet-4-6',
        maxTurns: 25,
        permissionMode: 'default',
      };
    }

    const agentConfig = getAgentConfig();
    if (options.model) agentConfig.model = options.model;

    if (options.orchestrate || (!options.task && parseInt(options.maxConcurrent) > 1)) {
      // Full orchestration mode
      const eventStore = new EventStore(db);
      const contextStore = new ContextStore(new ContextRepository(db));

      // Set up worktree manager (conditional on git repo)
      let worktreeManager: WorktreeManager | undefined;
      try {
        if (await isGitRepo(rootPath)) {
          worktreeManager = new WorktreeManager(db, {
            projectId,
            rootPath,
            worktreeDir: config.git.worktreeDir,
            branchPrefix: config.git.branchPrefix,
            integrationBranch: config.git.integrationBranch,
          });
        }
      } catch {
        // Not a git repo
      }

      // Set up MCP registry
      const mcpRegistry = new McpRegistry(db);

      const deps: OrchestratorDeps = {
        db,
        config,
        projectId,
        rootPath,
        runtimes,
        eventBus,
        eventStore,
        contextStore,
        taskRepo: repo,
        worktreeManager,
        mcpRegistry,
      };

      const orchestrator = new Orchestrator(deps);
      const maxConcurrent = parseInt(options.maxConcurrent);

      console.log(chalk.bold(`Starting orchestration (max concurrent: ${maxConcurrent})...\n`));

      // Handle SIGINT gracefully
      process.on('SIGINT', () => {
        console.log(chalk.yellow('\nStopping orchestration...'));
        orchestrator.stop();
      });

      await orchestrator.run({
        maxConcurrent,
        onTaskComplete: (task) => {
          console.log(chalk.green(`  Completed: ${task.title}`));
        },
        onTaskFailed: (task, error) => {
          console.error(chalk.red(`  Failed: ${task.title} - ${error}`));
        },
      });

      console.log(chalk.bold('\nOrchestration complete.'));
      return;
    }

    const executor = new Executor(runtimes, eventBus);

    if (options.task) {
      // Run a specific task
      const task = await repo.getById(options.task);
      if (!task) {
        console.error(chalk.red(`Task not found: ${options.task}`));
        process.exit(1);
      }

      console.log(chalk.bold(`Running task: ${task.title}`));
      console.log(chalk.dim(`  ID: ${task.id}`));
      console.log(chalk.dim(`  Agent: ${agentConfig.name} (${agentConfig.runtimeType})`));
      console.log('');

      // Transition to RUNNING (handle case where it might already be READY or PENDING)
      try {
        if (task.status === TaskStatus.PENDING) {
          await repo.transition(task.id, TaskStatus.READY);
        }
        if (task.status === TaskStatus.READY || task.status === TaskStatus.PENDING) {
          await repo.transition(task.id, TaskStatus.RUNNING);
        }
      } catch {
        await repo.transition(task.id, TaskStatus.RUNNING);
      }

      const result = await executor.execute(task, agentConfig, { cwd: rootPath });

      if (result.success) {
        await repo.transition(task.id, TaskStatus.COMPLETED);
        await repo.update(task.id, { outputArtifacts: result.outputArtifacts });
        console.log('');
        console.log(chalk.green('Task completed successfully.'));
        console.log(chalk.dim(`  Cost: $${result.totalCostUsd.toFixed(4)}`));
        console.log(chalk.dim(`  Turns: ${result.turnsUsed}`));
      } else {
        await repo.transition(task.id, TaskStatus.FAILED);
        console.log('');
        console.error(chalk.red('Task failed:'), result.error);
      }
    } else {
      // Run all ready tasks sequentially
      const ready = await repo.findReady(projectId);
      if (ready.length === 0) {
        console.log(chalk.gray('No ready tasks to execute.'));
        return;
      }

      console.log(chalk.bold(`Found ${ready.length} ready task(s). Running sequentially...\n`));

      for (const task of ready) {
        console.log(chalk.bold(`--- Task: ${task.title} ---`));
        await repo.transition(task.id, TaskStatus.RUNNING);

        const result = await executor.execute(task, agentConfig, { cwd: rootPath });

        if (result.success) {
          await repo.transition(task.id, TaskStatus.COMPLETED);
          await repo.update(task.id, { outputArtifacts: result.outputArtifacts });
          console.log(chalk.green(`  Completed. Cost: $${result.totalCostUsd.toFixed(4)}\n`));
        } else {
          await repo.transition(task.id, TaskStatus.FAILED);
          console.error(chalk.red(`  Failed: ${result.error}\n`));
        }
      }

      console.log(chalk.bold('Run complete.'));
    }
  });
