import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { AgentRegistry } from '../../agent/agent-registry.js';
import { loadProjectContext } from '../helpers.js';

export const agentCommand = new Command('agent')
  .description('Manage agents');

agentCommand
  .command('list')
  .description('List agent templates')
  .action(async () => {
    const { db, config } = loadProjectContext();
    const registry = new AgentRegistry(db);

    // Sync templates from config
    await registry.syncFromConfig(
      config.agents.templates.map((t) => ({ ...t, capabilities: t.capabilities ?? [] })),
    );

    const templates = await registry.listAll();

    if (templates.length === 0) {
      console.log(chalk.gray('No agent templates configured.'));
      console.log(chalk.dim('Add agent templates in orchestrator.config.yaml'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('ID'),
        chalk.bold('Name'),
        chalk.bold('Role'),
        chalk.bold('Runtime'),
        chalk.bold('Model'),
        chalk.bold('Capabilities'),
      ],
    });

    for (const t of templates) {
      table.push([
        t.id,
        t.name,
        t.role,
        t.runtimeType,
        t.model ?? '-',
        t.capabilities.map((c) => `${c.name}(${c.level})`).join(', ') || '-',
      ]);
    }

    console.log(table.toString());
  });

agentCommand
  .command('inspect <id>')
  .description('Show agent template details')
  .action(async (id) => {
    const { db } = loadProjectContext();
    const registry = new AgentRegistry(db);
    const template = await registry.getById(id);

    if (!template) {
      console.error(chalk.red(`Agent template not found: ${id}`));
      process.exit(1);
    }

    console.log(chalk.bold(`Agent: ${template.name}`));
    console.log(`  ID: ${template.id}`);
    console.log(`  Role: ${template.role}`);
    console.log(`  Runtime: ${template.runtimeType}`);
    console.log(`  Model: ${template.model ?? 'default'}`);
    console.log(`  Max Turns: ${template.maxTurns ?? 'unlimited'}`);
    console.log(`  Max Budget: ${template.maxBudgetUsd ? `$${template.maxBudgetUsd}` : 'unlimited'}`);
    console.log(`  Permission Mode: ${template.permissionMode ?? 'default'}`);

    if (template.capabilities.length > 0) {
      console.log('  Capabilities:');
      for (const cap of template.capabilities) {
        console.log(`    - ${cap.name} (${cap.level})`);
      }
    }

    if (template.allowedTools?.length) {
      console.log(`  Allowed Tools: ${template.allowedTools.join(', ')}`);
    }

    if (template.mcpServers?.length) {
      console.log(`  MCP Servers: ${template.mcpServers.join(', ')}`);
    }

    if (template.systemPrompt) {
      console.log('  System Prompt:');
      console.log(chalk.dim(`    ${template.systemPrompt.substring(0, 200)}...`));
    }
  });

agentCommand
  .command('add')
  .description('Add a new agent template')
  .requiredOption('--id <id>', 'Template ID')
  .requiredOption('--name <name>', 'Agent name')
  .requiredOption('--role <role>', 'Agent role')
  .option('--runtime <type>', 'Runtime type', 'claude-cli')
  .option('--model <model>', 'Model to use')
  .option('--max-turns <n>', 'Max turns')
  .option('--max-budget <usd>', 'Max budget in USD')
  .action(async (options) => {
    const { db } = loadProjectContext();
    const registry = new AgentRegistry(db);

    await registry.register({
      id: options.id,
      name: options.name,
      role: options.role,
      runtimeType: options.runtime,
      capabilities: [],
      model: options.model,
      maxTurns: options.maxTurns ? parseInt(options.maxTurns) : undefined,
      maxBudgetUsd: options.maxBudget ? parseFloat(options.maxBudget) : undefined,
    });

    console.log(chalk.green(`Agent template registered: ${options.id}`));
  });

agentCommand
  .command('remove <id>')
  .description('Remove an agent template')
  .action(async (id) => {
    const { db } = loadProjectContext();
    const registry = new AgentRegistry(db);
    await registry.delete(id);
    console.log(chalk.yellow(`Agent template removed: ${id}`));
  });
