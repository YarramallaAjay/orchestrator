/**
 * CLI command: orch workflow
 *
 * Run a workflow definition from a YAML file or inline.
 */

import { Command } from 'commander';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../../../platform/config/loader.js';
import { Platform } from '../../../platform/platform.js';
import { loadAgentFile, parseYamlAgent } from '../../agent-loader/parser.js';

export function createWorkflowCommand(): Command {
  const cmd = new Command('workflow')
    .description('Manage and run workflows');

  cmd
    .command('run')
    .description('Run a workflow from a definition file')
    .argument('<file>', 'Workflow definition file (.yaml/.yml)')
    .option('--cwd <dir>', 'Working directory', '.')
    .option('--max-concurrent <n>', 'Maximum concurrent executions', '3')
    .option('--max-budget <usd>', 'Maximum budget in USD')
    .action(async (file: string, opts: any) => {
      try {
        const { config } = loadConfig();
        const platform = await Platform.create(config);

        // Load workflow definition from YAML
        let yaml: any;
        try {
          const yamlModule = await import('yaml');
          const content = await readFile(resolve(file), 'utf-8');
          yaml = yamlModule.parse(content);
        } catch (err: any) {
          console.error(`Error loading workflow file: ${err.message}`);
          process.exit(1);
        }

        // Parse agent definitions referenced in the workflow
        const agentDefs = new Map();
        if (yaml.agents) {
          for (const agentDef of yaml.agents) {
            const def = parseYamlAgent(agentDef);
            agentDefs.set(def.name, def);
          }
        }

        // Build workflow nodes from config
        const nodes = (yaml.steps ?? yaml.nodes ?? []).map((step: any) => {
          const agentName = step.agent ?? step.runtime ?? 'default';
          const agent = agentDefs.get(agentName) ?? platform.getAgents().find(a => a.name === agentName);

          if (!agent) {
            console.error(`Agent '${agentName}' not found. Define it in the workflow file or platform config.`);
            process.exit(1);
          }

          return {
            id: step.id ?? step.name,
            name: step.name,
            agent,
            prompt: step.prompt ?? step.task ?? '',
            dependsOn: step.depends_on ?? step.dependsOn,
            priority: step.priority,
          };
        });

        console.log(`\n🚀 Running workflow: ${yaml.name ?? file}`);
        console.log(`   Steps: ${nodes.length}, Max concurrent: ${opts.maxConcurrent}\n`);

        // Subscribe to events for live output
        platform.eventBus.subscribe('workflow.*', (e) => {
          if (e.type === 'workflow.step.completed') {
            console.log(`   ✅ Step "${e.payload.stepName}" completed`);
          } else if (e.type === 'workflow.completed') {
            console.log(`\n✅ Workflow completed`);
          } else if (e.type === 'workflow.failed') {
            console.log(`\n❌ Workflow failed at step "${e.payload.failedStep}"`);
          }
        });

        const result = await platform.runWorkflow({
          name: yaml.name ?? file,
          nodes,
          cwd: resolve(opts.cwd),
          constraints: {
            maxConcurrent: parseInt(opts.maxConcurrent, 10),
            maxBudgetUsd: opts.maxBudget ? parseFloat(opts.maxBudget) : undefined,
          },
        });

        // Print metrics
        console.log(`\n📊 Metrics:`);
        console.log(`   Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`);
        if (result.metrics.costUsd) {
          console.log(`   Cost: $${result.metrics.costUsd.toFixed(4)}`);
        }
        if (result.metrics.inputTokens) {
          console.log(`   Tokens: ${result.metrics.inputTokens} in / ${result.metrics.outputTokens} out`);
        }

        process.exit(result.status === 'completed' ? 0 : 1);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
