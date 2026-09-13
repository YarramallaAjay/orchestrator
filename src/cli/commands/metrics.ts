import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { eq, desc, sql } from 'drizzle-orm';
import { loadProjectContext } from '../helpers.js';
import { orchestratorSessions, taskMetrics } from '../../db/schema.js';

export const metricsCommand = new Command('metrics')
  .description('View orchestrator performance metrics');

// Default: show project-level summary
metricsCommand
  .action(async () => {
    const ctx = loadProjectContext();

    const sessions = ctx.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.projectId, ctx.projectId))
      .all();

    if (sessions.length === 0) {
      console.log(chalk.gray('No orchestration sessions found. Run `orch orchestrate` first.'));
      return;
    }

    // Aggregate across all sessions
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    let totalTurns = 0;
    let totalTasksPlanned = 0;
    let totalTasksCompleted = 0;
    let totalTasksFailed = 0;
    let totalDuration = 0;

    for (const s of sessions) {
      totalCost += s.totalCostUsd;
      totalInputTokens += s.totalInputTokens;
      totalOutputTokens += s.totalOutputTokens;
      totalToolCalls += s.totalToolCalls;
      totalTurns += s.totalTurns;
      totalTasksPlanned += s.tasksPlanned;
      totalTasksCompleted += s.tasksCompleted;
      totalTasksFailed += s.tasksFailed;
      totalDuration += s.durationMs;
    }

    console.log(chalk.bold(`Project Metrics: ${ctx.config.project.name}\n`));

    const table = new Table({
      head: [chalk.bold('Metric'), chalk.bold('Value')],
      colWidths: [30, 25],
    });

    table.push(
      ['Total Sessions', String(sessions.length)],
      ['Tasks Planned', String(totalTasksPlanned)],
      ['Tasks Completed', chalk.green(String(totalTasksCompleted))],
      ['Tasks Failed', totalTasksFailed > 0 ? chalk.red(String(totalTasksFailed)) : '0'],
      ['Success Rate', totalTasksPlanned > 0 ? `${((totalTasksCompleted / totalTasksPlanned) * 100).toFixed(1)}%` : '-'],
      ['Total Cost', `$${totalCost.toFixed(4)}`],
      ['Total Input Tokens', totalInputTokens.toLocaleString()],
      ['Total Output Tokens', totalOutputTokens.toLocaleString()],
      ['Total Tokens', (totalInputTokens + totalOutputTokens).toLocaleString()],
      ['Total Tool Calls', String(totalToolCalls)],
      ['Total Turns', String(totalTurns)],
      ['Total Duration', `${(totalDuration / 1000).toFixed(1)}s`],
      ['Avg Cost/Session', `$${(totalCost / sessions.length).toFixed(4)}`],
      ['Avg Tokens/Session', Math.round((totalInputTokens + totalOutputTokens) / sessions.length).toLocaleString()],
    );

    console.log(table.toString());
  });

metricsCommand
  .command('sessions')
  .description('List all orchestration sessions for this project')
  .option('-n, --limit <n>', 'Number of sessions to show', '20')
  .action(async (options) => {
    const ctx = loadProjectContext();
    const limit = parseInt(options.limit);

    const sessions = ctx.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.projectId, ctx.projectId))
      .orderBy(desc(orchestratorSessions.startedAt))
      .limit(limit)
      .all();

    if (sessions.length === 0) {
      console.log(chalk.gray('No sessions found.'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('Session ID'),
        chalk.bold('Status'),
        chalk.bold('Tasks'),
        chalk.bold('Cost'),
        chalk.bold('Tokens'),
        chalk.bold('Tools'),
        chalk.bold('Turns'),
        chalk.bold('Duration'),
        chalk.bold('Started'),
      ],
      colWidths: [20, 12, 8, 10, 12, 8, 8, 10, 22],
    });

    for (const s of sessions) {
      const statusColor = s.status === 'completed' ? chalk.green
        : s.status === 'failed' ? chalk.red
        : chalk.yellow;

      table.push([
        s.id.substring(0, 18),
        statusColor(s.status),
        `${s.tasksCompleted}/${s.tasksPlanned}`,
        `$${s.totalCostUsd.toFixed(3)}`,
        (s.totalInputTokens + s.totalOutputTokens).toLocaleString(),
        String(s.totalToolCalls),
        String(s.totalTurns),
        `${(s.durationMs / 1000).toFixed(1)}s`,
        s.startedAt.substring(0, 19),
      ]);
    }

    console.log(chalk.bold('Orchestration Sessions:\n'));
    console.log(table.toString());
  });

metricsCommand
  .command('session')
  .description('Show detailed metrics for a specific session')
  .argument('<session-id>', 'Session ID')
  .action(async (sessionId) => {
    const ctx = loadProjectContext();

    const rows = ctx.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.id, sessionId))
      .all();

    const session = rows[0];
    if (!session) {
      console.error(chalk.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }

    console.log(chalk.bold(`Session: ${session.id}\n`));

    const table = new Table({
      head: [chalk.bold('Metric'), chalk.bold('Value')],
      colWidths: [25, 35],
    });

    const statusColor = session.status === 'completed' ? chalk.green
      : session.status === 'failed' ? chalk.red
      : chalk.yellow;

    table.push(
      ['Status', statusColor(session.status)],
      ['Started', session.startedAt],
      ['Completed', session.completedAt ?? '-'],
      ['Duration', `${(session.durationMs / 1000).toFixed(1)}s`],
      ['Tasks Planned', String(session.tasksPlanned)],
      ['Tasks Completed', chalk.green(String(session.tasksCompleted))],
      ['Tasks Failed', session.tasksFailed > 0 ? chalk.red(String(session.tasksFailed)) : '0'],
      ['Total Cost', `$${session.totalCostUsd.toFixed(4)}`],
      ['Input Tokens', session.totalInputTokens.toLocaleString()],
      ['Output Tokens', session.totalOutputTokens.toLocaleString()],
      ['Total Tokens', (session.totalInputTokens + session.totalOutputTokens).toLocaleString()],
      ['Tool Calls', String(session.totalToolCalls)],
      ['Turns', String(session.totalTurns)],
    );

    console.log(table.toString());

    // Show per-task metrics
    const tasks = ctx.db
      .select()
      .from(taskMetrics)
      .where(eq(taskMetrics.sessionId, sessionId))
      .all();

    if (tasks.length > 0) {
      console.log(chalk.bold('\nPer-Task Metrics:\n'));

      const taskTable = new Table({
        head: [
          chalk.bold('Task ID'),
          chalk.bold('Status'),
          chalk.bold('Cost'),
          chalk.bold('In Tokens'),
          chalk.bold('Out Tokens'),
          chalk.bold('Tools'),
          chalk.bold('Turns'),
          chalk.bold('Duration'),
          chalk.bold('Attempt'),
        ],
        colWidths: [20, 12, 10, 12, 12, 8, 8, 10, 9],
      });

      for (const t of tasks) {
        const statusColor = t.status === 'COMPLETED' ? chalk.green
          : t.status === 'FAILED' ? chalk.red
          : chalk.yellow;

        taskTable.push([
          t.taskId.substring(0, 18),
          statusColor(t.status),
          `$${t.costUsd.toFixed(3)}`,
          t.inputTokens.toLocaleString(),
          t.outputTokens.toLocaleString(),
          String(t.toolCalls),
          String(t.turns),
          `${(t.durationMs / 1000).toFixed(1)}s`,
          String(t.attempt),
        ]);
      }

      console.log(taskTable.toString());
    }
  });

metricsCommand
  .command('tasks')
  .description('Show per-task metrics for a session')
  .argument('<session-id>', 'Session ID')
  .action(async (sessionId) => {
    const ctx = loadProjectContext();

    const tasks = ctx.db
      .select()
      .from(taskMetrics)
      .where(eq(taskMetrics.sessionId, sessionId))
      .all();

    if (tasks.length === 0) {
      console.log(chalk.gray('No task metrics found for this session.'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('Task ID'),
        chalk.bold('Agent'),
        chalk.bold('Status'),
        chalk.bold('Cost'),
        chalk.bold('In Tokens'),
        chalk.bold('Out Tokens'),
        chalk.bold('Tool Calls'),
        chalk.bold('Turns'),
        chalk.bold('Duration'),
        chalk.bold('Attempt'),
      ],
      colWidths: [20, 14, 12, 10, 12, 12, 12, 8, 10, 9],
    });

    for (const t of tasks) {
      const statusColor = t.status === 'COMPLETED' ? chalk.green
        : t.status === 'FAILED' ? chalk.red
        : chalk.yellow;

      table.push([
        t.taskId.substring(0, 18),
        t.agentId?.substring(0, 12) ?? '-',
        statusColor(t.status),
        `$${t.costUsd.toFixed(3)}`,
        t.inputTokens.toLocaleString(),
        t.outputTokens.toLocaleString(),
        String(t.toolCalls),
        String(t.turns),
        `${(t.durationMs / 1000).toFixed(1)}s`,
        String(t.attempt),
      ]);
    }

    console.log(chalk.bold(`Task Metrics for Session ${sessionId}:\n`));
    console.log(table.toString());
  });
