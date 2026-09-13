import chalk from 'chalk';
import Table from 'cli-table3';
import type { Task } from '../task/types.js';
import { TaskStatus } from '../task/types.js';

const STATUS_COLORS: Record<TaskStatus, (s: string) => string> = {
  [TaskStatus.PENDING]: chalk.gray,
  [TaskStatus.READY]: chalk.cyan,
  [TaskStatus.RUNNING]: chalk.yellow,
  [TaskStatus.BLOCKED]: chalk.red,
  [TaskStatus.WAITING_FOR_HUMAN]: chalk.magenta,
  [TaskStatus.COMPLETED]: chalk.green,
  [TaskStatus.FAILED]: chalk.red.bold,
  [TaskStatus.CANCELLED]: chalk.strikethrough.gray,
};

export function formatStatus(status: TaskStatus): string {
  const colorFn = STATUS_COLORS[status] ?? chalk.white;
  return colorFn(status);
}

export function formatTaskTable(tasks: Task[]): string {
  const table = new Table({
    head: [
      chalk.bold('ID'),
      chalk.bold('Title'),
      chalk.bold('Status'),
      chalk.bold('Priority'),
      chalk.bold('Agent'),
      chalk.bold('Deps'),
    ],
    colWidths: [20, 40, 22, 10, 16, 8],
    wordWrap: true,
  });

  for (const task of tasks) {
    table.push([
      task.id.substring(0, 18),
      task.title,
      formatStatus(task.status),
      String(task.priority),
      task.assignedAgentId ?? '-',
      String(task.dependsOn.length),
    ]);
  }

  return table.toString();
}

export function formatTaskDetail(task: Task): string {
  const lines: string[] = [
    `${chalk.bold('Task:')} ${task.title}`,
    `${chalk.bold('ID:')} ${task.id}`,
    `${chalk.bold('Status:')} ${formatStatus(task.status)}`,
    `${chalk.bold('Classification:')} ${task.classification}`,
    `${chalk.bold('Priority:')} ${task.priority}`,
    `${chalk.bold('Agent:')} ${task.assignedAgentId ?? 'unassigned'}`,
    `${chalk.bold('Attempt:')} ${task.attempt}/${task.maxRetries}`,
    '',
    chalk.bold('Description:'),
    task.description,
  ];

  if (task.dependsOn.length > 0) {
    lines.push('', chalk.bold('Dependencies:'));
    for (const dep of task.dependsOn) {
      lines.push(`  - ${dep}`);
    }
  }

  if (task.acceptanceCriteria.length > 0) {
    lines.push('', chalk.bold('Acceptance Criteria:'));
    for (const criterion of task.acceptanceCriteria) {
      lines.push(`  - ${criterion}`);
    }
  }

  if (task.tags.length > 0) {
    lines.push(`\n${chalk.bold('Tags:')} ${task.tags.join(', ')}`);
  }

  lines.push(
    '',
    `${chalk.dim('Created:')} ${task.createdAt}`,
    `${chalk.dim('Updated:')} ${task.updatedAt}`,
  );

  if (task.startedAt) lines.push(`${chalk.dim('Started:')} ${task.startedAt}`);
  if (task.completedAt) lines.push(`${chalk.dim('Completed:')} ${task.completedAt}`);

  return lines.join('\n');
}

export function formatProjectStatus(
  projectName: string,
  tasks: Task[],
): string {
  const counts = {
    total: tasks.length,
    pending: 0,
    ready: 0,
    running: 0,
    blocked: 0,
    waitingForHuman: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const task of tasks) {
    switch (task.status) {
      case TaskStatus.PENDING: counts.pending++; break;
      case TaskStatus.READY: counts.ready++; break;
      case TaskStatus.RUNNING: counts.running++; break;
      case TaskStatus.BLOCKED: counts.blocked++; break;
      case TaskStatus.WAITING_FOR_HUMAN: counts.waitingForHuman++; break;
      case TaskStatus.COMPLETED: counts.completed++; break;
      case TaskStatus.FAILED: counts.failed++; break;
      case TaskStatus.CANCELLED: counts.cancelled++; break;
    }
  }

  const progress = counts.total > 0
    ? Math.round((counts.completed / counts.total) * 100)
    : 0;

  const lines = [
    chalk.bold(`Project: ${projectName}`),
    `Progress: ${progressBar(progress)} ${progress}%`,
    '',
    `  ${chalk.gray('Pending:')}          ${counts.pending}`,
    `  ${chalk.cyan('Ready:')}            ${counts.ready}`,
    `  ${chalk.yellow('Running:')}          ${counts.running}`,
    `  ${chalk.red('Blocked:')}          ${counts.blocked}`,
    `  ${chalk.magenta('Waiting (Human):')}  ${counts.waitingForHuman}`,
    `  ${chalk.green('Completed:')}        ${counts.completed}`,
    `  ${chalk.red.bold('Failed:')}           ${counts.failed}`,
    `  ${chalk.gray('Cancelled:')}        ${counts.cancelled}`,
    `  ${chalk.bold('Total:')}            ${counts.total}`,
  ];

  return lines.join('\n');
}

function progressBar(percent: number, width: number = 30): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}
