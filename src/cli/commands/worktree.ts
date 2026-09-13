import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { WorktreeManager } from '../../git/worktree-manager.js';
import { MergeCoordinator } from '../../git/merge-coordinator.js';
import { loadProjectContext } from '../helpers.js';

function createWorktreeManager(ctx: ReturnType<typeof loadProjectContext>) {
  return new WorktreeManager(ctx.db, {
    projectId: ctx.projectId,
    rootPath: ctx.rootPath,
    worktreeDir: ctx.config.git.worktreeDir,
    branchPrefix: ctx.config.git.branchPrefix,
    integrationBranch: ctx.config.git.integrationBranch,
  });
}

export const worktreeCommand = new Command('worktree')
  .description('Manage git worktrees');

worktreeCommand
  .command('list')
  .description('List all worktrees')
  .action(async () => {
    const ctx = loadProjectContext();
    const manager = createWorktreeManager(ctx);
    const wts = await manager.list();

    if (wts.length === 0) {
      console.log(chalk.gray('No worktrees found.'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Branch'),
        chalk.bold('Task'),
        chalk.bold('Agent'),
        chalk.bold('Status'),
      ],
    });

    for (const wt of wts) {
      const statusColor = wt.status === 'ACTIVE' ? chalk.green : wt.status === 'MERGED' ? chalk.blue : chalk.gray;
      table.push([
        wt.id.substring(0, 16),
        wt.branch,
        wt.taskId?.substring(0, 16) ?? '-',
        wt.agentId?.substring(0, 16) ?? '-',
        statusColor(wt.status),
      ]);
    }

    console.log(table.toString());
  });

worktreeCommand
  .command('clean')
  .description('Clean up merged and abandoned worktrees')
  .action(async () => {
    const ctx = loadProjectContext();
    const manager = createWorktreeManager(ctx);
    const cleaned = await manager.cleanup();
    console.log(chalk.green(`Cleaned ${cleaned} worktree(s).`));
  });

worktreeCommand
  .command('merge <id>')
  .description('Merge a worktree branch back to integration branch')
  .option('--target <branch>', 'Target branch to merge into')
  .action(async (id, options) => {
    const ctx = loadProjectContext();
    const manager = createWorktreeManager(ctx);
    const coordinator = new MergeCoordinator(manager);

    console.log(chalk.bold('Merging worktree...'));
    const result = await coordinator.mergeSingle(id, options.target);

    if (result.success) {
      console.log(chalk.green('Merge successful.'));
      if (result.mergeCommit) {
        console.log(chalk.dim(`  Commit: ${result.mergeCommit}`));
      }
    } else {
      console.error(chalk.red('Merge failed due to conflicts:'));
      for (const conflict of result.conflicts) {
        console.error(`  - ${conflict.file}: ${conflict.description}`);
      }
    }
  });

worktreeCommand
  .command('remove <id>')
  .description('Remove a worktree')
  .option('--delete-branch', 'Also delete the branch')
  .action(async (id, options) => {
    const ctx = loadProjectContext();
    const manager = createWorktreeManager(ctx);
    await manager.remove(id, options.deleteBranch);
    console.log(chalk.yellow('Worktree removed.'));
  });

worktreeCommand
  .command('integrate')
  .description('Plan and execute integration of all active worktrees')
  .option('--dry-run', 'Show plan without executing')
  .option('--stop-on-conflict', 'Stop if any merge has conflicts')
  .action(async (options) => {
    const ctx = loadProjectContext();
    const manager = createWorktreeManager(ctx);
    const coordinator = new MergeCoordinator(manager);

    console.log(chalk.bold('Planning integration...'));
    const plan = await coordinator.planIntegration();

    if (plan.order.length === 0) {
      console.log(chalk.gray('No active worktrees to integrate.'));
      return;
    }

    console.log(`  Worktrees to merge: ${plan.order.length}`);
    if (plan.conflicts.length > 0) {
      console.log(chalk.yellow(`  Potential conflicts: ${plan.conflicts.length}`));
    }

    for (const wt of plan.order) {
      console.log(`  - ${wt.branch} (${wt.id.substring(0, 12)})`);
    }

    if (options.dryRun) return;

    console.log('');
    const results = await coordinator.executeIntegration(
      plan.order.map((wt) => wt.id),
      { stopOnConflict: options.stopOnConflict },
    );

    let successCount = 0;
    let failCount = 0;
    for (const [wtId, result] of results) {
      if (result.success) {
        successCount++;
        console.log(chalk.green(`  Merged: ${wtId.substring(0, 12)}`));
      } else {
        failCount++;
        console.error(chalk.red(`  Failed: ${wtId.substring(0, 12)} (${result.conflicts.length} conflicts)`));
      }
    }

    console.log(`\n${chalk.bold('Integration complete:')} ${successCount} merged, ${failCount} failed`);
  });
