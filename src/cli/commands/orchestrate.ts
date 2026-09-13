import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import Table from 'cli-table3';
import { TaskRepository } from '../../task/task-repository.js';
import { ClaudeCliRuntime } from '../../agent/runtimes/claude-cli-runtime.js';
import { Orchestrator, type OrchestratorDeps, type ProgressEvent } from '../../core/orchestrator.js';
import { EventBus } from '../../events/event-bus.js';
import { EventStore } from '../../events/event-store.js';
import { ContextStore } from '../../context/context-store.js';
import { ContextRepository } from '../../context/context-repository.js';
import { SessionManager } from '../../core/session-manager.js';
import { loadProjectContext } from '../helpers.js';
import { formatTaskTable } from '../formatters.js';
import type { Task } from '../../task/types.js';
import type { AgentRuntime } from '../../agent/runtimes/runtime.js';

function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export const orchestrateCommand = new Command('orchestrate')
  .description('Run full orchestration pipeline from requirements (with plan approval)')
  .argument('[requirements-file]', 'Path to requirements file (markdown, text, etc.)')
  .option('--inline <text>', 'Provide requirements as inline text')
  .option('--max-concurrent <n>', 'Maximum concurrent agents', '1')
  .option('--auto-approve', 'Skip plan approval prompt (for programmatic use)')
  .option('--resume', 'Resume the last interrupted session')
  .action(async (requirementsFile, options) => {
    const ctx = loadProjectContext();
    const { db, projectId, config, rootPath } = ctx;

    // Resolve requirements text
    let requirements: string;

    if (options.resume) {
      const sessionManager = new SessionManager(rootPath);
      const latest = sessionManager.getLatest(projectId);
      if (!latest || latest.status === 'completed') {
        console.error(chalk.red('No interrupted session to resume.'));
        process.exit(1);
      }
      console.log(chalk.yellow(`Resuming session ${latest.sessionId}...`));
      requirements = '';
    } else if (options.inline) {
      requirements = options.inline;
    } else if (requirementsFile) {
      requirements = readFileSync(requirementsFile, 'utf-8');
    } else {
      console.error(chalk.red('Provide a requirements file, --inline text, or --resume.'));
      process.exit(1);
    }

    // Set up orchestrator
    const eventBus = new EventBus();
    const eventStore = new EventStore(db);
    const taskRepo = new TaskRepository(db);
    const contextStore = new ContextStore(new ContextRepository(db));
    const cliRuntime = new ClaudeCliRuntime();
    const runtimes = new Map<string, AgentRuntime>([['claude-cli', cliRuntime]]);

    const deps: OrchestratorDeps = {
      db,
      config,
      projectId,
      rootPath,
      runtimes,
      eventBus,
      eventStore,
      contextStore,
      taskRepo,
    };

    const orchestrator = new Orchestrator(deps);
    const maxConcurrent = parseInt(options.maxConcurrent);

    // Handle SIGINT
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\nStopping orchestration (session will be saved for resume)...'));
      orchestrator.stop();
    });

    console.log(chalk.bold('Starting orchestration...\n'));

    // Progress display
    const onProgress = (event: ProgressEvent) => {
      const stageIcons: Record<string, string> = {
        planning: '[PLAN]',
        awaiting_approval: '[APPROVAL]',
        scheduling: '[SCHED]',
        executing: '[EXEC]',
        validating: '[VALID]',
        completed: '[DONE]',
      };
      const icon = stageIcons[event.stage] ?? `[${event.stage.toUpperCase()}]`;

      if (event.stage === 'completed') {
        console.log('');
        console.log(chalk.bold(`${icon} ${event.message}`));
      } else if (event.task) {
        const statusColor = event.message.startsWith('Failed') ? chalk.red : chalk.green;
        console.log(`  ${chalk.dim(icon)} ${statusColor(event.message)}`);
        console.log(chalk.dim(`    Progress: ${event.tasksCompleted} done, ${event.tasksFailed} failed, ${event.tasksRemaining} remaining`));
      } else {
        console.log(`${chalk.cyan(icon)} ${event.message}`);
      }
    };

    // Plan approval callback
    const onPlanReady = options.autoApprove
      ? undefined
      : async (tasks: Task[]): Promise<boolean> => {
          console.log('');
          console.log(chalk.bold('Task Plan:'));
          console.log(formatTaskTable(tasks));
          console.log('');
          console.log(chalk.dim(`${tasks.length} tasks planned.`));
          console.log('');

          const answer = await askUser(chalk.yellow('Approve this plan and start execution? (y/n): '));
          const approved = answer === 'y' || answer === 'yes';

          if (!approved) {
            console.log(chalk.gray('Plan rejected. No tasks will be executed.'));
          } else {
            console.log(chalk.green('Plan approved. Starting execution...\n'));
          }

          return approved;
        };

    let result;

    if (options.resume) {
      console.log(chalk.cyan('[RESUME] Running remaining tasks...\n'));
      await orchestrator.run({
        maxConcurrent,
        onTaskComplete: (task) => console.log(chalk.green(`  Completed: ${task.title}`)),
        onTaskFailed: (task, error) => console.error(chalk.red(`  Failed: ${task.title} — ${error}`)),
      });

      const allTasks = await taskRepo.findByProject(projectId);
      const completed = allTasks.filter((t) => t.status === 'COMPLETED');
      const failed = allTasks.filter((t) => t.status === 'FAILED');
      result = {
        success: failed.length === 0,
        tasks: allTasks,
        completedTasks: completed,
        failedTasks: failed,
        cancelledTasks: allTasks.filter((t) => t.status === 'CANCELLED'),
        totalCostUsd: 0,
        durationMs: 0,
        sessionId: 'resumed',
        summary: `${completed.length}/${allTasks.length} tasks completed`,
        metrics: { totalInputTokens: 0, totalOutputTokens: 0, totalToolCalls: 0, totalTurns: 0 },
      };
    } else {
      result = await orchestrator.orchestrate(requirements, {
        maxConcurrent,
        onProgress,
        onPlanReady,
      });
    }

    // Final summary table
    console.log('');
    const summaryTable = new Table({
      head: [chalk.bold('Metric'), chalk.bold('Value')],
      colWidths: [25, 35],
    });
    summaryTable.push(
      ['Status', result.success ? chalk.green('SUCCESS') : chalk.red('FAILURE')],
      ['Tasks Total', String(result.tasks.length)],
      ['Completed', chalk.green(String(result.completedTasks.length))],
      ['Failed', result.failedTasks.length > 0 ? chalk.red(String(result.failedTasks.length)) : '0'],
      ['Cancelled', String(result.cancelledTasks.length)],
      ['Duration', `${(result.durationMs / 1000).toFixed(1)}s`],
      ['Cost', `$${result.totalCostUsd.toFixed(4)}`],
      ['Input Tokens', result.metrics.totalInputTokens.toLocaleString()],
      ['Output Tokens', result.metrics.totalOutputTokens.toLocaleString()],
      ['Tool Calls', String(result.metrics.totalToolCalls)],
      ['Turns', String(result.metrics.totalTurns)],
      ['Session', result.sessionId],
    );
    console.log(summaryTable.toString());

    if (result.failedTasks.length > 0) {
      console.log(chalk.red('\nFailed tasks:'));
      for (const task of result.failedTasks) {
        console.log(chalk.red(`  - ${task.title} (${task.id})`));
      }
    }

    if (!result.success) {
      process.exit(1);
    }
  });
