import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { eq, desc } from 'drizzle-orm';
import { loadProjectContext } from '../helpers.js';
import { EvalRunner } from '../../eval/eval-runner.js';
import { ReportGenerator } from '../../eval/report-generator.js';
import { builtinScenarios } from '../../eval/builtin-scenarios.js';
import { evalRuns } from '../../db/schema.js';
import type { EvalScenario, EvalResult } from '../../eval/types.js';

export const evalCommand = new Command('eval')
  .description('Run evaluation scenarios against the orchestrator');

evalCommand
  .command('run')
  .description('Run eval scenario(s)')
  .argument('[scenario-file]', 'Path to YAML file with eval scenarios')
  .option('--builtin', 'Run built-in sanity scenarios')
  .option('--scenario <name>', 'Run a specific scenario by name')
  .option('--dry-run', 'Plan only, do not execute tasks')
  .option('--report <format>', 'Output format: table or json', 'table')
  .action(async (scenarioFile, options) => {
    const ctx = loadProjectContext();
    const reporter = new ReportGenerator();

    let scenarios: EvalScenario[] = [];

    if (options.builtin) {
      scenarios = builtinScenarios;
    } else if (scenarioFile) {
      const content = readFileSync(scenarioFile, 'utf-8');
      const parsed = parseYaml(content);
      scenarios = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      console.error(chalk.red('Provide a scenario file or use --builtin'));
      process.exit(1);
    }

    if (options.scenario) {
      scenarios = scenarios.filter((s) => s.name === options.scenario);
      if (scenarios.length === 0) {
        console.error(chalk.red(`Scenario not found: ${options.scenario}`));
        process.exit(1);
      }
    }

    console.log(chalk.bold(`Running ${scenarios.length} eval scenario(s)...\n`));

    const runner = new EvalRunner({
      dryRun: options.dryRun,
      db: ctx.db,
      projectConfig: ctx.config,
    });

    const results = await runner.runScenarios(scenarios);

    for (const result of results) {
      if (options.report === 'json') {
        console.log(reporter.formatJson(result));
      } else {
        console.log(reporter.formatTable(result));
      }
      console.log('');
    }

    // Summary
    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const errors = results.filter((r) => r.status === 'error').length;

    console.log(chalk.bold('Summary:'));
    console.log(`  ${chalk.green(`Passed: ${passed}`)}  ${chalk.red(`Failed: ${failed}`)}  ${chalk.yellow(`Errors: ${errors}`)}`);

    if (failed > 0 || errors > 0) {
      process.exit(1);
    }
  });

evalCommand
  .command('list')
  .description('List available built-in eval scenarios')
  .action(() => {
    console.log(chalk.bold('Built-in Eval Scenarios:\n'));
    for (const scenario of builtinScenarios) {
      console.log(`  ${chalk.cyan(scenario.name)}`);
      console.log(`    ${scenario.description}`);
      console.log(`    Budget: $${scenario.maxBudgetUsd}  Timeout: ${scenario.maxDurationMs / 1000}s`);
      console.log(`    Checks: ${scenario.validationChecks.map((c) => c.name).join(', ')}`);
      console.log('');
    }
  });

evalCommand
  .command('history')
  .description('Show past eval runs')
  .option('-n, --limit <n>', 'Number of runs to show', '20')
  .action(async (options) => {
    const ctx = loadProjectContext();
    const reporter = new ReportGenerator();
    const limit = parseInt(options.limit);

    const runs = ctx.db
      .select()
      .from(evalRuns)
      .orderBy(desc(evalRuns.startedAt))
      .limit(limit)
      .all();

    if (runs.length === 0) {
      console.log(chalk.gray('No eval runs found.'));
      return;
    }

    console.log(reporter.formatHistory(runs.map((r) => ({
      id: r.id,
      scenario_name: r.scenarioName,
      status: r.status,
      started_at: r.startedAt,
      completed_at: r.completedAt,
    }))));
  });

evalCommand
  .command('report')
  .description('Show detailed report for an eval run')
  .argument('<run-id>', 'Eval run ID')
  .option('--format <format>', 'Output format: table or json', 'table')
  .action(async (runId, options) => {
    const ctx = loadProjectContext();
    const reporter = new ReportGenerator();

    const rows = ctx.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.id, runId))
      .all();

    const run = rows[0];
    if (!run) {
      console.error(chalk.red(`Eval run not found: ${runId}`));
      process.exit(1);
    }

    const metrics = run.metrics ? JSON.parse(run.metrics) : null;
    if (!metrics) {
      console.error(chalk.red('No metrics available for this run.'));
      process.exit(1);
    }

    const result: EvalResult = {
      scenario: run.scenarioName,
      status: run.status as EvalResult['status'],
      metrics,
      checks: [],
      error: run.notes ?? undefined,
      runId: run.id,
    };

    if (options.format === 'json') {
      console.log(reporter.formatJson(result));
    } else {
      console.log(reporter.formatTable(result));
    }
  });

evalCommand
  .command('compare')
  .description('Compare two eval runs side-by-side')
  .argument('<id1>', 'First eval run ID')
  .argument('<id2>', 'Second eval run ID')
  .action(async (id1, id2) => {
    const ctx = loadProjectContext();
    const reporter = new ReportGenerator();

    const run1 = ctx.db.select().from(evalRuns).where(eq(evalRuns.id, id1)).all()[0];
    const run2 = ctx.db.select().from(evalRuns).where(eq(evalRuns.id, id2)).all()[0];

    if (!run1 || !run2) {
      console.error(chalk.red('One or both eval runs not found.'));
      process.exit(1);
    }

    const metrics1 = run1.metrics ? JSON.parse(run1.metrics) : null;
    const metrics2 = run2.metrics ? JSON.parse(run2.metrics) : null;

    if (!metrics1 || !metrics2) {
      console.error(chalk.red('Metrics not available for one or both runs.'));
      process.exit(1);
    }

    const result1: EvalResult = {
      scenario: run1.scenarioName,
      status: run1.status as EvalResult['status'],
      metrics: metrics1,
      checks: [],
      runId: run1.id,
    };
    const result2: EvalResult = {
      scenario: run2.scenarioName,
      status: run2.status as EvalResult['status'],
      metrics: metrics2,
      checks: [],
      runId: run2.id,
    };

    console.log(reporter.formatComparison(result1, result2));
  });
