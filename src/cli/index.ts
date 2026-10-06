import { Command } from 'commander';
import { grillMeCommand } from './commands/grill-me.js';
import { registerPlatformCommands } from '../layer4-surface/cli/index.js';

export function createCli(): Command {
  const program = new Command('orch')
    .description('Universal AI Agent Platform')
    .version('0.5.0');

  // Platform commands (run, init, status, workflow, agent)
  registerPlatformCommands(program);

  // Standalone utility commands
  program.addCommand(grillMeCommand);

  return program;
}
