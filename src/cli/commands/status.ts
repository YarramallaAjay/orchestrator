import { Command } from 'commander';
import chalk from 'chalk';
import { TaskRepository } from '../../task/task-repository.js';
import { formatProjectStatus, formatTaskTable } from '../formatters.js';
import { loadProjectContext } from '../helpers.js';

export const statusCommand = new Command('status')
  .description('Show project status')
  .action(async () => {
    const { db, projectId, config } = loadProjectContext();
    const repo = new TaskRepository(db);
    const tasks = await repo.findByProject(projectId);

    console.log(formatProjectStatus(config.project.name, tasks));

    if (tasks.length > 0) {
      console.log('\n' + formatTaskTable(tasks));
    }
  });
