import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { taskCommand } from './commands/task.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { planCommand } from './commands/plan.js';
import { contextCommand } from './commands/context.js';
import { agentCommand } from './commands/agent.js';
import { worktreeCommand } from './commands/worktree.js';
import { serveCommand } from './commands/serve.js';
import { configCommand } from './commands/config.js';
import { evalCommand } from './commands/eval.js';
import { hooksCommand } from './commands/hooks.js';
import { orchestrateCommand } from './commands/orchestrate.js';

export function createCli(): Command {
  const program = new Command('orch')
    .description('Multi-Agent Development Orchestrator')
    .version('0.1.0');

  program.addCommand(initCommand);
  program.addCommand(taskCommand);
  program.addCommand(runCommand);
  program.addCommand(statusCommand);
  program.addCommand(planCommand);
  program.addCommand(contextCommand);
  program.addCommand(agentCommand);
  program.addCommand(worktreeCommand);
  program.addCommand(serveCommand);
  program.addCommand(configCommand);
  program.addCommand(orchestrateCommand);
  program.addCommand(evalCommand);
  program.addCommand(hooksCommand);

  return program;
}
