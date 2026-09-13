import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ContextRepository } from '../../context/context-repository.js';
import { ContextCategory } from '../../context/types.js';
import { loadProjectContext } from '../helpers.js';

export const contextCommand = new Command('context')
  .description('Manage shared project context');

contextCommand
  .command('set <key> <value-or-file>')
  .description('Set a context entry (value or @filepath)')
  .option('-c, --category <category>', 'Context category', 'DECISION')
  .option('-t, --title <title>', 'Context title')
  .option('-u, --updated-by <who>', 'Who is updating', 'human')
  .action(async (key, valueOrFile, options) => {
    const { db, projectId } = loadProjectContext();
    const repo = new ContextRepository(db);

    let content: string;
    if (valueOrFile.startsWith('@')) {
      const filePath = resolve(valueOrFile.substring(1));
      if (!existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        process.exit(1);
      }
      content = readFileSync(filePath, 'utf-8');
    } else {
      content = valueOrFile;
    }

    const category = options.category.toUpperCase() as ContextCategory;
    if (!Object.values(ContextCategory).includes(category)) {
      console.error(chalk.red(`Invalid category: ${options.category}`));
      console.log('Valid categories:', Object.values(ContextCategory).join(', '));
      process.exit(1);
    }

    const entry = await repo.set({
      projectId,
      key,
      category,
      title: options.title ?? key,
      content,
      updatedBy: options.updatedBy,
    });

    console.log(chalk.green(`Context set: ${entry.key} (v${entry.version})`));
  });

contextCommand
  .command('get <key>')
  .description('Get a context entry')
  .action(async (key) => {
    const { db, projectId } = loadProjectContext();
    const repo = new ContextRepository(db);

    const entry = await repo.get(projectId, key);
    if (!entry) {
      console.error(chalk.red(`Context entry not found: ${key}`));
      process.exit(1);
    }

    console.log(chalk.bold(`${entry.title} (${entry.key})`));
    console.log(chalk.dim(`Category: ${entry.category} | Version: ${entry.version} | Updated by: ${entry.updatedBy}`));
    console.log(chalk.dim(`Updated: ${entry.updatedAt}`));
    console.log('');
    console.log(entry.content);
  });

contextCommand
  .command('list')
  .description('List all context entries')
  .option('-c, --category <category>', 'Filter by category')
  .action(async (options) => {
    const { db, projectId } = loadProjectContext();
    const repo = new ContextRepository(db);

    const category = options.category?.toUpperCase() as ContextCategory | undefined;
    const entries = await repo.list(projectId, category);

    if (entries.length === 0) {
      console.log(chalk.gray('No context entries found.'));
      return;
    }

    for (const entry of entries) {
      console.log(`${chalk.cyan(entry.key)} ${chalk.dim(`[${entry.category}]`)} ${entry.title} ${chalk.dim(`(v${entry.version})`)}`);
    }
  });

contextCommand
  .command('delete <key>')
  .description('Delete a context entry')
  .action(async (key) => {
    const { db, projectId } = loadProjectContext();
    const repo = new ContextRepository(db);

    await repo.delete(projectId, key);
    console.log(chalk.yellow(`Context entry deleted: ${key}`));
  });

contextCommand
  .command('history <key>')
  .description('Show version history for a context entry')
  .action(async (key) => {
    const { db, projectId } = loadProjectContext();
    const repo = new ContextRepository(db);

    const history = await repo.getHistory(projectId, key);
    if (history.length === 0) {
      console.log(chalk.gray('No history found.'));
      return;
    }

    for (const h of history) {
      console.log(`${chalk.dim(`v${h.version}`)} by ${h.updatedBy} at ${h.createdAt}`);
      console.log(`  ${h.content.substring(0, 100)}${h.content.length > 100 ? '...' : ''}`);
      console.log('');
    }
  });
