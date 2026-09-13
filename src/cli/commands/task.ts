import { Command } from 'commander';
import chalk from 'chalk';
import { TaskRepository } from '../../task/task-repository.js';
import { TaskStatus, TaskClassification } from '../../task/types.js';
import { formatTaskTable, formatTaskDetail } from '../formatters.js';
import { loadProjectContext } from '../helpers.js';

export const taskCommand = new Command('task')
  .description('Manage tasks');

taskCommand
  .command('add')
  .description('Add a new task')
  .requiredOption('-t, --title <title>', 'Task title')
  .requiredOption('-d, --desc <description>', 'Task description')
  .option('--depends-on <ids>', 'Comma-separated task IDs this depends on')
  .option('--priority <n>', 'Priority (0 = highest)', '100')
  .option('--classification <type>', 'Task classification', 'LOCAL')
  .option('--tags <tags>', 'Comma-separated tags')
  .option('--criteria <criteria>', 'Comma-separated acceptance criteria')
  .option('--validation <script>', 'Validation script/command')
  .action(async (options) => {
    const { db, projectId } = loadProjectContext();
    const repo = new TaskRepository(db);

    const task = await repo.create({
      projectId,
      title: options.title,
      description: options.desc,
      priority: parseInt(options.priority, 10),
      classification: (options.classification as TaskClassification) ?? TaskClassification.LOCAL,
      dependsOn: options.dependsOn ? options.dependsOn.split(',').map((s: string) => s.trim()) : [],
      tags: options.tags ? options.tags.split(',').map((s: string) => s.trim()) : [],
      acceptanceCriteria: options.criteria ? options.criteria.split(',').map((s: string) => s.trim()) : [],
      validationScript: options.validation,
    });

    console.log(chalk.green('Task created:'), task.id);
    console.log(`  Title: ${task.title}`);
    console.log(`  Status: ${task.status}`);
  });

taskCommand
  .command('list')
  .description('List tasks')
  .option('-s, --status <statuses>', 'Filter by status (comma-separated)')
  .action(async (options) => {
    const { db, projectId } = loadProjectContext();
    const repo = new TaskRepository(db);

    let tasks;
    if (options.status) {
      const statuses = options.status.split(',').map((s: string) => s.trim().toUpperCase() as TaskStatus);
      tasks = await repo.findByStatus(projectId, statuses);
    } else {
      tasks = await repo.findByProject(projectId);
    }

    if (tasks.length === 0) {
      console.log(chalk.gray('No tasks found.'));
      return;
    }

    console.log(formatTaskTable(tasks));
  });

taskCommand
  .command('show <id>')
  .description('Show task details')
  .action(async (id) => {
    const { db } = loadProjectContext();
    const repo = new TaskRepository(db);

    const task = await repo.getById(id);
    if (!task) {
      console.error(chalk.red(`Task not found: ${id}`));
      process.exit(1);
    }

    console.log(formatTaskDetail(task));
  });

taskCommand
  .command('cancel <id>')
  .description('Cancel a task')
  .option('--cascade', 'Also cancel dependent tasks')
  .action(async (id, options) => {
    const { db } = loadProjectContext();
    const repo = new TaskRepository(db);

    const task = await repo.getById(id);
    if (!task) {
      console.error(chalk.red(`Task not found: ${id}`));
      process.exit(1);
    }

    if (options.cascade) {
      // Load all project tasks to build the graph for cascade
      const { TaskGraph } = await import('../../task/task-graph.js');
      const { projectId } = loadProjectContext();
      const allTasks = await repo.findByProject(projectId);
      const graph = new TaskGraph();
      for (const t of allTasks) graph.addTask(t);
      const cancelled = graph.cascadeCancel(id);

      for (const cid of cancelled) {
        await repo.transition(cid, TaskStatus.CANCELLED);
      }

      console.log(chalk.yellow(`Cancelled ${cancelled.length} task(s):`));
      for (const cid of cancelled) {
        console.log(`  - ${cid}`);
      }
    } else {
      await repo.transition(id, TaskStatus.CANCELLED);
      console.log(chalk.yellow(`Task cancelled: ${id}`));
    }
  });
