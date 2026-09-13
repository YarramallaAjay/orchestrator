import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ClaudeCliRuntime } from '../../agent/runtimes/claude-cli-runtime.js';
import { Planner } from '../../core/planner.js';
import { TaskRepository } from '../../task/task-repository.js';
import { TaskStatus } from '../../task/types.js';
import { formatTaskTable } from '../formatters.js';
import { loadProjectContext } from '../helpers.js';

export const planCommand = new Command('plan')
  .description('Decompose requirements into a task graph')
  .argument('<file>', 'Requirements file (markdown, text, etc.)')
  .option('--dry-run', 'Show plan without persisting')
  .option('--model <model>', 'Model to use for planning', 'claude-sonnet-4-6')
  .action(async (file, options) => {
    const ctx = loadProjectContext();
    const { db, projectId } = ctx;

    const filePath = resolve(file);
    const requirements = readFileSync(filePath, 'utf-8');

    console.log(chalk.bold('Planning...'));
    console.log(chalk.dim(`  File: ${filePath}`));
    console.log(chalk.dim(`  Model: ${options.model}`));
    console.log('');

    const runtime = new ClaudeCliRuntime();
    const planner = new Planner(runtime, {
      projectId,
      model: options.model,
    });

    try {
      const taskInputs = await planner.decompose(requirements);

      if (options.dryRun) {
        console.log(chalk.bold(`Plan: ${taskInputs.length} tasks\n`));
        for (let i = 0; i < taskInputs.length; i++) {
          const t = taskInputs[i]!;
          console.log(`${chalk.cyan(`${i + 1}.`)} ${t.title}`);
          console.log(`   ${chalk.dim(t.description.substring(0, 100))}`);
          if (t.dependsOn?.length) {
            console.log(`   ${chalk.yellow('Depends on:')} ${t.dependsOn.join(', ')}`);
          }
          console.log('');
        }
        return;
      }

      // Create tasks
      const repo = new TaskRepository(db);
      const created = [];
      const tempIdToRealId = new Map<string, string>();

      // First pass: create without dependencies
      for (let i = 0; i < taskInputs.length; i++) {
        const input = { ...taskInputs[i]! };
        const tempDeps = input.dependsOn ?? [];
        input.dependsOn = [];

        const task = await repo.create(input);
        created.push(task);
        tempIdToRealId.set(`__temp_${i}`, task.id);
      }

      // Second pass: add dependencies
      for (let i = 0; i < taskInputs.length; i++) {
        const originalDeps = taskInputs[i]!.dependsOn ?? [];
        const task = created[i]!;

        for (const tempDep of originalDeps) {
          const realDepId = tempIdToRealId.get(tempDep);
          if (realDepId) {
            await repo.addDependency({
              taskId: task.id,
              dependsOnTaskId: realDepId,
              type: 'BLOCKS',
            });
            if (task.status === TaskStatus.READY) {
              await repo.transition(task.id, TaskStatus.PENDING);
            }
          }
        }
      }

      // Promote tasks with all deps met
      for (const task of created) {
        const deps = await repo.getDependencies(task.id);
        if (deps.length === 0 && task.status === TaskStatus.PENDING) {
          // Already READY from creation
        }
      }

      console.log(chalk.green(`Created ${created.length} tasks.\n`));

      const allTasks = await repo.findByProject(projectId);
      console.log(formatTaskTable(allTasks));
    } catch (error) {
      console.error(chalk.red('Planning failed:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
