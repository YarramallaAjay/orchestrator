import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadProjectContext } from '../helpers.js';
import { ContextStore } from '../../context/context-store.js';
import { ContextRepository } from '../../context/context-repository.js';
import { ObservationStore } from '../../context/observation-store.js';
import { ClaudeCodeAdapter } from '../../harness/adapters/claude-code-adapter.js';
import { HarnessGateway } from '../../harness/harness-gateway.js';
import type { WrapOptions } from '../../harness/types.js';

function printBanner(
  harness: string,
  projectId: string,
  rootPath: string,
  wrapOptions: WrapOptions,
): void {
  console.log('');
  console.log(chalk.cyan.bold('  orch wrap'));
  console.log(chalk.dim('  ─────────────────────────────────'));
  console.log(`  ${chalk.white('Harness:')}   ${chalk.green(harness)}`);
  console.log(`  ${chalk.white('Project:')}   ${chalk.dim(projectId)}`);
  console.log(`  ${chalk.white('Root:')}      ${chalk.dim(rootPath)}`);
  if (wrapOptions.model) {
    console.log(`  ${chalk.white('Model:')}     ${chalk.dim(wrapOptions.model)}`);
  }
  console.log('');

  // Feature status
  const status = (enabled: boolean) =>
    enabled ? chalk.green('on') : chalk.red('off');

  console.log(`  ${chalk.white('Hooks:')}     ${status(!wrapOptions.disableHooks)}   ${chalk.dim('context injection at session start + each prompt')}`);
  console.log(`  ${chalk.white('MCP:')}       ${status(!wrapOptions.disableMcp)}   ${chalk.dim('publish_observation, store_memory, recall_memory')}`);
  console.log(`  ${chalk.white('Memory:')}    ${status(!wrapOptions.disableMemory)}   ${chalk.dim('cross-session knowledge persistence')}`);
  console.log(`  ${chalk.white('Budget:')}    ${chalk.dim(`${wrapOptions.tokenBudget} tokens`)}`);
  console.log(chalk.dim('  ─────────────────────────────────'));
  console.log('');
}

function printPostLaunchStatus(rootPath: string, wrapOptions: WrapOptions): void {
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

  // Check context file was written
  const contextFile = resolve(rootPath, '.orchestrator', '.wrap-context.json');
  if (existsSync(contextFile)) {
    try {
      const data = JSON.parse(readFileSync(contextFile, 'utf-8'));
      const sections = Object.keys(data).filter((k) => data[k]);
      checks.push({
        label: 'Context',
        ok: true,
        detail: `${sections.length} section(s): ${sections.join(', ')}`,
      });
    } catch {
      checks.push({ label: 'Context', ok: false, detail: 'file corrupt' });
    }
  } else {
    checks.push({ label: 'Context', ok: false, detail: 'file not written' });
  }

  // Check hooks installed
  if (!wrapOptions.disableHooks) {
    const settingsPath = resolve(rootPath, '.claude', 'settings.local.json');
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const hasSessionStart = settings.hooks?.SessionStart?.some(
          (h: any) => h.hooks?.some((hook: any) => hook.command?.includes('wrap-session-start')),
        );
        const hasPromptSubmit = settings.hooks?.UserPromptSubmit?.some(
          (h: any) => h.hooks?.some((hook: any) => hook.command?.includes('wrap-prompt-submit')),
        );
        checks.push({
          label: 'Hooks',
          ok: hasSessionStart && hasPromptSubmit,
          detail: hasSessionStart && hasPromptSubmit
            ? 'SessionStart + UserPromptSubmit installed'
            : `SessionStart: ${hasSessionStart ? 'yes' : 'no'}, UserPromptSubmit: ${hasPromptSubmit ? 'yes' : 'no'}`,
        });
      } catch {
        checks.push({ label: 'Hooks', ok: false, detail: 'settings.local.json unreadable' });
      }
    } else {
      checks.push({ label: 'Hooks', ok: false, detail: 'settings.local.json not found' });
    }
  }

  // Check MCP config
  if (!wrapOptions.disableMcp) {
    const mcpConfig = resolve(rootPath, '.orchestrator', '.wrap-mcp-config.json');
    if (existsSync(mcpConfig)) {
      try {
        const config = JSON.parse(readFileSync(mcpConfig, 'utf-8'));
        const serverName = Object.keys(config.mcpServers || {})[0] || 'none';
        checks.push({ label: 'MCP', ok: true, detail: `server: ${serverName}` });
      } catch {
        checks.push({ label: 'MCP', ok: false, detail: 'config corrupt' });
      }
    } else {
      checks.push({ label: 'MCP', ok: false, detail: 'config not written' });
    }
  }

  // Check state directory
  const stateDir = resolve(rootPath, '.orchestrator', '.wrap-state');
  checks.push({
    label: 'State',
    ok: existsSync(stateDir),
    detail: existsSync(stateDir) ? '.wrap-state/ ready' : '.wrap-state/ missing',
  });

  console.log(chalk.cyan('  Pre-launch checks:'));
  for (const check of checks) {
    const icon = check.ok ? chalk.green('  [ok]') : chalk.red('  [!!]');
    console.log(`  ${icon} ${chalk.white(check.label)}: ${chalk.dim(check.detail)}`);
  }

  const allOk = checks.every((c) => c.ok);
  if (allOk) {
    console.log('');
    console.log(chalk.green('  All systems ready. Launching harness...'));
  } else {
    console.log('');
    console.log(chalk.yellow('  Some checks failed. Launching anyway...'));
  }
  console.log('');
}

function printSessionSummary(
  rootPath: string,
  exitCode: number,
  durationMs: number,
  sessionId: string | null,
): void {
  console.log('');
  console.log(chalk.dim('  ─────────────────────────────────'));
  console.log(chalk.cyan.bold('  Session Summary'));
  console.log(`  ${chalk.white('Exit code:')}  ${exitCode === 0 ? chalk.green(exitCode) : chalk.red(exitCode)}`);
  console.log(`  ${chalk.white('Duration:')}   ${chalk.dim(formatDuration(durationMs))}`);
  if (sessionId) {
    console.log(`  ${chalk.white('Session:')}    ${chalk.dim(sessionId)}`);
  }

  // Check if observations were published during this session
  const observationsFile = resolve(rootPath, '.orchestrator', '.wrap-state', 'observations.json');
  if (existsSync(observationsFile)) {
    try {
      const observations = JSON.parse(readFileSync(observationsFile, 'utf-8'));
      if (Array.isArray(observations) && observations.length > 0) {
        console.log(`  ${chalk.white('Observations:')} ${chalk.green(`${observations.length} published`)}`);
      }
    } catch { /* ignore */ }
  }

  console.log(chalk.dim('  ─────────────────────────────────'));
  console.log('');
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export const wrapCommand = new Command('wrap')
  .description('Wrap an AI coding harness with orchestrator context, memory, and tools')
  .argument('<harness>', 'Harness to wrap (currently: claude)')
  .option('--model <model>', 'Override the model used by the harness')
  .option('--no-mcp', 'Disable MCP sidecar tools')
  .option('--no-hooks', 'Disable context injection hooks')
  .option('--no-memory', 'Disable cross-session memory')
  .option('--resume <session>', 'Resume a previous session by ID')
  .option('--token-budget <n>', 'Max tokens for injected context', '8192')
  .option('--verify', 'Run pre-launch checks and exit without launching')
  .allowUnknownOption(true)
  .action(async (harness: string, options, command) => {
    // Validate harness
    if (harness !== 'claude') {
      console.error(chalk.red(`Unknown harness: ${harness}`));
      console.error(chalk.dim('Supported harnesses: claude'));
      process.exit(1);
    }

    // Load project context
    let ctx;
    try {
      ctx = loadProjectContext();
    } catch (err: any) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }

    const { db, projectId, rootPath } = ctx;

    // Create adapter
    const adapter = new ClaudeCodeAdapter();

    // Check availability
    const available = await adapter.isAvailable();
    if (!available) {
      console.error(chalk.red('Claude Code CLI not found.'));
      console.error(chalk.dim('Install it with: npm install -g @anthropic-ai/claude-code'));
      process.exit(1);
    }

    // Build stores
    const contextRepo = new ContextRepository(db);
    const contextStore = new ContextStore(contextRepo);
    const observationStore = new ObservationStore(db);

    // Build gateway
    const gateway = new HarnessGateway({
      adapter,
      db,
      projectId,
      rootPath,
      contextStore,
      observationStore,
    });

    // Parse wrap options
    const wrapOptions: WrapOptions = {
      model: options.model,
      disableMcp: options.mcp === false,
      disableHooks: options.hooks === false,
      disableMemory: options.memory === false,
      resumeSession: options.resume,
      tokenBudget: parseInt(options.tokenBudget, 10) || 8192,
      additionalArgs: command.args.slice(1),
    };

    // Print startup banner
    printBanner(harness, projectId, rootPath, wrapOptions);

    // Verify-only mode: check what exists without launching
    if (options.verify) {
      printPostLaunchStatus(rootPath, wrapOptions);
      console.log(chalk.dim('  Tip: Run without --verify to launch the harness.'));
      console.log('');
      process.exit(0);
    }

    try {
      const result = await gateway.launch(wrapOptions, (gw) => {
        // Callback after pre-launch setup, before harness spawn
        printPostLaunchStatus(rootPath, wrapOptions);
      });

      printSessionSummary(rootPath, result.exitCode, result.durationMs, result.sessionId);

      process.exit(result.exitCode);
    } catch (err: any) {
      console.error(chalk.red(`Wrap session failed: ${err.message}`));
      process.exit(1);
    }
  });
