import { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { stringify as yamlStringify } from 'yaml';
import { createDb, initializeDb } from '../../db/connection.js';
import { DEFAULT_CONFIG, CONFIG_FILENAME, ORCHESTRATOR_DIR } from '../../config/defaults.js';
import { generateId } from '../../util/id.js';
import { projects } from '../../db/schema.js';

export const initCommand = new Command('init')
  .description('Initialize a new orchestrator project')
  .option('-n, --name <name>', 'Project name')
  .option('-p, --path <dir>', 'Project root directory', '.')
  .action(async (options) => {
    const rootPath = resolve(options.path);
    const projectName = options.name ?? 'my-project';

    // Check if already initialized
    const configPath = resolve(rootPath, CONFIG_FILENAME);
    if (existsSync(configPath)) {
      console.log(chalk.yellow('Project already initialized. Config found at:'), configPath);
      return;
    }

    // Create .orchestrator directory
    const orchDir = resolve(rootPath, ORCHESTRATOR_DIR);
    mkdirSync(orchDir, { recursive: true });

    // Create config file
    const config = {
      ...DEFAULT_CONFIG,
      project: { name: projectName, rootPath: '.' },
    };
    writeFileSync(configPath, yamlStringify(config), 'utf-8');

    // Initialize database
    const dbPath = resolve(rootPath, config.database.path);
    const db = createDb(dbPath);
    initializeDb(db);

    // Create the project record
    const now = new Date().toISOString();
    db.insert(projects).values({
      id: generateId('proj'),
      name: projectName,
      rootPath: rootPath,
      configPath: configPath,
      createdAt: now,
      updatedAt: now,
    }).run();

    console.log(chalk.green('Orchestrator project initialized.'));
    console.log(`  Config: ${configPath}`);
    console.log(`  Database: ${dbPath}`);
    console.log(`\nEdit ${chalk.cyan(CONFIG_FILENAME)} to configure agents, MCP servers, and more.`);
  });
