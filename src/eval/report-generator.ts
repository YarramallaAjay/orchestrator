import chalk from 'chalk';
import Table from 'cli-table3';
import type { EvalResult, EvalMetrics } from './types.js';

/**
 * Generates eval reports in table or JSON format.
 */
export class ReportGenerator {
  formatTable(result: EvalResult): string {
    const lines: string[] = [];

    const statusColor = result.status === 'passed' ? chalk.green
      : result.status === 'failed' ? chalk.red
      : chalk.yellow;

    lines.push(chalk.bold(`Eval: ${result.scenario}`));
    lines.push(`Status: ${statusColor(result.status.toUpperCase())}`);
    lines.push(`Run ID: ${result.runId}`);
    if (result.error) {
      lines.push(`Error: ${chalk.red(result.error)}`);
    }
    lines.push('');

    // Metrics table
    lines.push(chalk.bold('Metrics:'));
    const metricsTable = new Table({
      head: [chalk.bold('Metric'), chalk.bold('Value')],
      colWidths: [35, 25],
    });

    const m = result.metrics;
    metricsTable.push(
      ['Planning Duration', `${m.planningDurationMs}ms`],
      ['Tasks Planned', String(m.tasksPlanned)],
      ['Dependency Depth', String(m.dependencyDepth)],
      ['Tasks Completed', String(m.tasksCompleted)],
      ['Tasks Failed', String(m.tasksFailed)],
      ['Tasks Cancelled', String(m.tasksCancelled)],
      ['Tasks Retried', String(m.tasksRetried)],
      ['Total Retries', String(m.totalRetries)],
      ['Validation Pass Rate', `${(m.validationPassRate * 100).toFixed(1)}%`],
      ['Total Cost', `$${m.totalCostUsd.toFixed(4)}`],
      ['Cost Per Task', `$${m.costPerTask.toFixed(4)}`],
      ['Total Duration', `${m.totalDurationMs}ms`],
      ['Avg Task Duration', `${m.avgTaskDurationMs.toFixed(0)}ms`],
      ['Longest Task', `${m.longestTaskMs}ms`],
      ['Shortest Task', `${m.shortestTaskMs}ms`],
      ['Agents Used', String(m.agentsUsed)],
      ['Max Concurrent Agents', String(m.maxConcurrentAgents)],
    );
    lines.push(metricsTable.toString());

    // Classification breakdown
    if (Object.keys(m.tasksByClassification).length > 0) {
      lines.push('');
      lines.push(chalk.bold('Tasks by Classification:'));
      const classTable = new Table({
        head: [chalk.bold('Classification'), chalk.bold('Count')],
        colWidths: [25, 10],
      });
      for (const [cls, count] of Object.entries(m.tasksByClassification)) {
        classTable.push([cls, String(count)]);
      }
      lines.push(classTable.toString());
    }

    // Cost by agent
    if (Object.keys(m.costByAgent).length > 0) {
      lines.push('');
      lines.push(chalk.bold('Cost by Agent:'));
      const costTable = new Table({
        head: [chalk.bold('Agent'), chalk.bold('Cost')],
        colWidths: [25, 15],
      });
      for (const [agent, cost] of Object.entries(m.costByAgent)) {
        costTable.push([agent, `$${cost.toFixed(4)}`]);
      }
      lines.push(costTable.toString());
    }

    // Checks
    lines.push('');
    lines.push(chalk.bold('Checks:'));
    const checksTable = new Table({
      head: [chalk.bold('Check'), chalk.bold('Result'), chalk.bold('Actual'), chalk.bold('Expected')],
      colWidths: [30, 10, 15, 15],
    });
    for (const check of result.checks) {
      checksTable.push([
        check.name,
        check.passed ? chalk.green('PASS') : chalk.red('FAIL'),
        String(check.actual),
        String(check.expected),
      ]);
    }
    lines.push(checksTable.toString());

    return lines.join('\n');
  }

  formatJson(result: EvalResult): string {
    return JSON.stringify(result, null, 2);
  }

  formatComparison(result1: EvalResult, result2: EvalResult): string {
    const lines: string[] = [];

    lines.push(chalk.bold('Eval Comparison'));
    lines.push('');

    const table = new Table({
      head: [chalk.bold('Metric'), chalk.bold(result1.runId), chalk.bold(result2.runId), chalk.bold('Delta')],
      colWidths: [30, 20, 20, 15],
    });

    const comparisons: Array<[string, number, number]> = [
      ['Tasks Planned', result1.metrics.tasksPlanned, result2.metrics.tasksPlanned],
      ['Tasks Completed', result1.metrics.tasksCompleted, result2.metrics.tasksCompleted],
      ['Tasks Failed', result1.metrics.tasksFailed, result2.metrics.tasksFailed],
      ['Total Retries', result1.metrics.totalRetries, result2.metrics.totalRetries],
      ['Validation Pass Rate', result1.metrics.validationPassRate, result2.metrics.validationPassRate],
      ['Total Cost ($)', result1.metrics.totalCostUsd, result2.metrics.totalCostUsd],
      ['Total Duration (ms)', result1.metrics.totalDurationMs, result2.metrics.totalDurationMs],
      ['Agents Used', result1.metrics.agentsUsed, result2.metrics.agentsUsed],
    ];

    for (const [name, v1, v2] of comparisons) {
      const delta = v2 - v1;
      const deltaStr = delta > 0 ? chalk.yellow(`+${delta.toFixed(2)}`)
        : delta < 0 ? chalk.green(`${delta.toFixed(2)}`)
        : chalk.gray('0');
      table.push([name, v1.toFixed(2), v2.toFixed(2), deltaStr]);
    }

    lines.push(table.toString());
    return lines.join('\n');
  }

  formatHistory(runs: Array<{ id: string; scenario_name: string; status: string; started_at: string; completed_at: string | null }>): string {
    const table = new Table({
      head: [chalk.bold('Run ID'), chalk.bold('Scenario'), chalk.bold('Status'), chalk.bold('Started'), chalk.bold('Duration')],
      colWidths: [20, 25, 12, 22, 15],
    });

    for (const run of runs) {
      const statusColor = run.status === 'passed' ? chalk.green
        : run.status === 'failed' ? chalk.red
        : run.status === 'running' ? chalk.yellow
        : chalk.gray;

      const duration = run.completed_at
        ? `${new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()}ms`
        : '-';

      table.push([
        run.id.substring(0, 18),
        run.scenario_name,
        statusColor(run.status),
        run.started_at.substring(0, 19),
        duration,
      ]);
    }

    return table.toString();
  }
}
