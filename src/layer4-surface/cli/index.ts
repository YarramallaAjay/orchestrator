/**
 * CLI command registration.
 *
 * M1: init, run, status
 * M3: workflow, agent
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { createWorkflowCommand } from './commands/workflow.js';
import { createAgentCommand } from './commands/agent.js';

export function registerPlatformCommands(program: Command): void {
  // ── orch init ──────────────────────────────────────────────────────────
  program
    .command('init')
    .description('Initialize platform config in the current directory')
    .option('-d, --dir <path>', 'Directory to initialize in')
    .action(async (opts) => {
      await initCommand(opts);
    });

  // ── orch run ───────────────────────────────────────────────────────────
  program
    .command('run <prompt>')
    .description('Execute an agent with a prompt')
    .option('-a, --agent <name>', 'Agent name from config')
    .option('-c, --cwd <path>', 'Working directory')
    .option('--no-stream', 'Disable streaming output')
    .action(async (prompt, opts) => {
      await runCommand(prompt, opts);
    });

  // ── orch status ────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show platform and project status')
    .option('-c, --cwd <path>', 'Working directory')
    .action(async (opts) => {
      await statusCommand(opts);
    });

  // ── orch workflow ──────────────────────────────────────────────────────
  program.addCommand(createWorkflowCommand());

  // ── orch agent ─────────────────────────────────────────────────────────
  program.addCommand(createAgentCommand());
}
