/**
 * orch status -- show platform and project status.
 */

import chalk from 'chalk';
import { loadConfig } from '../../../platform/config/loader.js';

export async function statusCommand(options: { cwd?: string }): Promise<void> {
  let config;
  try {
    const loaded = loadConfig(options.cwd);
    config = loaded.config;
    console.log(chalk.bold(`Platform Status`));
    console.log();
    console.log(`  Project:    ${config.project.name}`);
    console.log(`  Root:       ${config.project.root_path}`);
    console.log(`  Config:     ${loaded.configPath}`);
    console.log();
    console.log(`  Execution:`);
    console.log(`    Max concurrent: ${config.execution.max_concurrent}`);
    console.log(`    Max budget:     $${config.execution.max_budget_usd}`);
    console.log(`    Auto retry:     ${config.execution.auto_retry}`);
    console.log(`    Max retries:    ${config.execution.max_retries}`);
    console.log();
    console.log(`  Agents: ${config.agents.length} configured`);
    for (const agent of config.agents) {
      console.log(`    - ${agent.name} (${agent.runtime ?? 'default'})`);
    }
    console.log();
    console.log(`  Runtimes: ${config.runtimes.length} configured`);
    for (const rt of config.runtimes) {
      console.log(`    - ${rt.name} (${rt.type}, priority ${rt.priority})`);
    }
  } catch (err: any) {
    console.log(chalk.yellow(`No platform config found.`));
    console.log(`Run ${chalk.bold('orch init')} to create one.`);
  }
}
