/**
 * CLI command: orch agent
 *
 * List, inspect, and load agent definitions.
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { loadConfig } from '../../../platform/config/loader.js';
import { Platform } from '../../../platform/platform.js';
import { loadAgentFile } from '../../agent-loader/parser.js';

export function createAgentCommand(): Command {
  const cmd = new Command('agent')
    .description('Manage agent definitions');

  cmd
    .command('list')
    .description('List all configured agents')
    .action(async () => {
      try {
        const { config } = loadConfig();
        const platform = await Platform.create(config);
        const agents = platform.getAgents();

        if (agents.length === 0) {
          console.log('No agents configured. Add agents to your platform.config.yaml.');
          return;
        }

        console.log(`\nAgents (${agents.length}):\n`);
        for (const agent of agents) {
          const runtime = agent.runtime ?? '(auto)';
          const caps = agent.capabilities.length > 0
            ? agent.capabilities.join(', ')
            : '(none)';
          console.log(`  ${agent.name}`);
          console.log(`    Runtime: ${runtime}  |  Capabilities: ${caps}`);
          if (agent.description) {
            console.log(`    ${agent.description}`);
          }
          console.log();
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command('inspect')
    .description('Inspect an agent definition file')
    .argument('<file>', 'Agent file (.yaml, .yml, or .md)')
    .action(async (file: string) => {
      try {
        const agent = await loadAgentFile(resolve(file));

        console.log(`\nAgent: ${agent.name}`);
        console.log(`  Source: ${agent.source}`);
        console.log(`  Runtime: ${agent.runtime ?? '(auto)'}`);
        console.log(`  Capabilities: ${agent.capabilities.join(', ') || '(none)'}`);
        console.log(`  Memory: scope=${agent.memory.scope}, access=${agent.memory.access}`);
        console.log(`  Max Retries: ${agent.preferences.maxRetries}`);
        console.log(`  Timeout: ${agent.preferences.timeoutMs / 1000}s`);

        if (agent.description) {
          console.log(`  Description: ${agent.description}`);
        }

        if (agent.steps) {
          console.log(`\n  Steps (${agent.steps.length}):`);
          for (const step of agent.steps) {
            const deps = step.dependsOn?.length ? ` [depends on: ${step.dependsOn.join(', ')}]` : '';
            console.log(`    - ${step.name}: ${step.description}${deps}`);
          }
        }

        if (agent.instructions) {
          console.log(`\n  Instructions:\n    ${agent.instructions.substring(0, 200)}${agent.instructions.length > 200 ? '...' : ''}`);
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command('runtimes')
    .description('List available runtime adapters')
    .action(async () => {
      try {
        const { config } = loadConfig();
        const platform = await Platform.create(config);
        const types = platform.adapters.types();

        console.log(`\nAvailable Runtimes (${types.length}):\n`);
        for (const type of types) {
          try {
            const adapter = platform.adapters.create(type, { id: 'probe', type, cwd: '.' });
            console.log(`  ${type}`);
            console.log(`    Capabilities: ${adapter.capabilities.join(', ')}`);
            console.log();
          } catch {
            console.log(`  ${type} (failed to probe)`);
          }
        }
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
