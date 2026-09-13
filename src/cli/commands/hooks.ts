import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import chalk from 'chalk';

export const hooksCommand = new Command('hooks')
  .description('Manage Claude Code hooks for orchestrator auto-pickup');

function getSettingsPath(cwd: string): string {
  return resolve(cwd, '.claude', 'settings.json');
}

function getModulePath(): string {
  // Resolve the path to the hooks relative to this package
  const hookDir = resolve(dirname(new URL(import.meta.url).pathname), '..', '..', 'hooks');
  return hookDir;
}

function readSettings(settingsPath: string): Record<string, any> {
  if (existsSync(settingsPath)) {
    return JSON.parse(readFileSync(settingsPath, 'utf-8'));
  }
  return {};
}

function writeSettings(settingsPath: string, settings: Record<string, any>): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

hooksCommand
  .command('install')
  .description('Install Claude Code hooks for orchestrator auto-pickup')
  .action(async () => {
    const cwd = process.cwd();
    const settingsPath = getSettingsPath(cwd);
    const hookDir = getModulePath();

    const settings = readSettings(settingsPath);

    if (!settings.hooks) {
      settings.hooks = {};
    }

    // SessionStart hook
    settings.hooks.SessionStart = [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `node ${resolve(hookDir, 'session-start.js')}`,
          },
        ],
      },
    ];

    // UserPromptSubmit hook
    settings.hooks.UserPromptSubmit = [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `node ${resolve(hookDir, 'prompt-intercept.js')}`,
          },
        ],
      },
    ];

    writeSettings(settingsPath, settings);

    console.log(chalk.green('Claude Code hooks installed successfully.'));
    console.log(chalk.dim(`  Settings: ${settingsPath}`));
    console.log(chalk.dim(`  SessionStart hook: session-start.js`));
    console.log(chalk.dim(`  UserPromptSubmit hook: prompt-intercept.js`));
    console.log('');
    console.log('Next time you start Claude Code in this directory,');
    console.log('it will detect the orchestrator and offer to activate it.');
  });

hooksCommand
  .command('uninstall')
  .description('Remove Claude Code hooks for orchestrator auto-pickup')
  .action(async () => {
    const cwd = process.cwd();
    const settingsPath = getSettingsPath(cwd);

    if (!existsSync(settingsPath)) {
      console.log(chalk.gray('No settings file found. Nothing to uninstall.'));
      return;
    }

    const settings = readSettings(settingsPath);

    if (settings.hooks) {
      delete settings.hooks.SessionStart;
      delete settings.hooks.UserPromptSubmit;

      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    writeSettings(settingsPath, settings);

    // Remove session marker if present
    const markerPath = resolve(cwd, '.orchestrator', 'session-active');
    if (existsSync(markerPath)) {
      rmSync(markerPath);
      console.log(chalk.dim('  Removed session-active marker.'));
    }

    console.log(chalk.green('Claude Code hooks uninstalled.'));
  });

hooksCommand
  .command('status')
  .description('Show whether hooks are installed and active')
  .action(async () => {
    const cwd = process.cwd();
    const settingsPath = getSettingsPath(cwd);
    const markerPath = resolve(cwd, '.orchestrator', 'session-active');

    // Check hooks installation
    let hooksInstalled = false;
    if (existsSync(settingsPath)) {
      const settings = readSettings(settingsPath);
      hooksInstalled = !!(settings.hooks?.SessionStart || settings.hooks?.UserPromptSubmit);
    }

    // Check session active
    const sessionActive = existsSync(markerPath);
    let sessionInfo: Record<string, string> | null = null;
    if (sessionActive) {
      try {
        sessionInfo = JSON.parse(readFileSync(markerPath, 'utf-8'));
      } catch {
        // Invalid marker file
      }
    }

    console.log(chalk.bold('Orchestrator Hooks Status:\n'));
    console.log(`  Hooks installed: ${hooksInstalled ? chalk.green('Yes') : chalk.gray('No')}`);
    console.log(`  Session active:  ${sessionActive ? chalk.green('Yes') : chalk.gray('No')}`);

    if (sessionInfo) {
      console.log(`  Activated at:    ${sessionInfo.activatedAt}`);
      console.log(`  Config:          ${sessionInfo.config}`);
    }

    if (!hooksInstalled) {
      console.log(`\n  Run ${chalk.cyan('orch hooks install')} to set up auto-pickup.`);
    }
  });
