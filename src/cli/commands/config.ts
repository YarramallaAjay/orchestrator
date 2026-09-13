import { Command } from 'commander';
import chalk from 'chalk';
import { loadProjectContext } from '../helpers.js';

export const configCommand = new Command('config')
  .description('View or modify project configuration');

configCommand
  .command('show')
  .description('Show current configuration')
  .action(async () => {
    const ctx = loadProjectContext();
    const { stringify } = await import('yaml');
    console.log(stringify(ctx.config));
  });

configCommand
  .command('get <key>')
  .description('Get a config value (dot notation, e.g. orchestrator.maxConcurrentAgents)')
  .action(async (key) => {
    const ctx = loadProjectContext();
    const parts = key.split('.');
    let value: any = ctx.config;

    for (const part of parts) {
      if (value === undefined || value === null) break;
      value = value[part];
    }

    if (value === undefined) {
      console.error(chalk.red(`Config key not found: ${key}`));
      process.exit(1);
    }

    if (typeof value === 'object') {
      const { stringify } = await import('yaml');
      console.log(stringify(value));
    } else {
      console.log(String(value));
    }
  });
