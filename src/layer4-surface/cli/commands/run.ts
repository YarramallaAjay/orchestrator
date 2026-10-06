/**
 * orch run -- execute an agent with a prompt.
 *
 * M1: Single agent execution, streaming output to terminal.
 */

import chalk from 'chalk';
import { loadConfig } from '../../../platform/config/loader.js';
import { Platform } from '../../../platform/platform.js';

export async function runCommand(
  prompt: string,
  options: {
    agent?: string;
    cwd?: string;
    stream?: boolean;
  },
): Promise<void> {
  // Load config
  let config;
  try {
    const loaded = loadConfig(options.cwd);
    config = loaded.config;
    console.log(chalk.dim(`Config: ${loaded.configPath}`));
  } catch (err: any) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  // Create platform
  const platform = await Platform.create(config);

  console.log(chalk.blue(`\nExecuting: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`));
  console.log(chalk.dim(`Runtime: ${options.agent ?? 'default (claude-code)'}`));
  console.log(chalk.dim(`CWD: ${options.cwd ?? config.project.root_path}`));
  console.log();

  const startTime = Date.now();

  if (options.stream !== false) {
    // Streaming mode (default)
    for await (const event of platform.runStreaming({
      prompt,
      agentName: options.agent,
      cwd: options.cwd,
    })) {
      switch (event.type) {
        case 'progress':
          console.log(chalk.dim(`[progress] ${event.message}`));
          break;
        case 'output':
          // Don't print full output in streaming mode -- too noisy
          break;
        case 'tool_use':
          console.log(chalk.yellow(`[tool] ${event.tool}`));
          break;
        case 'error':
          console.log(chalk.red(`[error] ${event.error.message}`));
          break;
        case 'done': {
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log();

          if (event.result.success) {
            console.log(chalk.green(`Done (${duration}s)`));
          } else {
            console.log(chalk.red(`Failed (${duration}s)`));
          }

          // Print metrics
          const m = event.result.metrics;
          console.log(chalk.dim([
            `Cost: $${m.costUsd.toFixed(4)}`,
            `Tokens: ${m.inputTokens + m.outputTokens}`,
            `Tools: ${m.toolCalls}`,
            `Turns: ${m.turns}`,
          ].join(' | ')));

          // Print files modified
          if (event.result.filesModified?.length) {
            console.log(chalk.dim(`\nFiles modified:`));
            for (const f of event.result.filesModified) {
              console.log(chalk.dim(`  ${f}`));
            }
          }

          // Print output summary
          if (event.result.output) {
            console.log(chalk.dim(`\nOutput:`));
            const output = event.result.output;
            if (output.length > 500) {
              console.log(output.slice(0, 500) + '...');
            } else {
              console.log(output);
            }
          }

          if (!event.result.success) {
            process.exit(1);
          }
          break;
        }
      }
    }
  } else {
    // Non-streaming mode
    const result = await platform.run({
      prompt,
      agentName: options.agent,
      cwd: options.cwd,
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (result.status === 'completed') {
      console.log(chalk.green(`Done (${duration}s)`));
    } else {
      console.log(chalk.red(`Failed (${duration}s): ${result.error}`));
      process.exit(1);
    }

    if (result.metrics) {
      console.log(chalk.dim([
        `Cost: $${result.metrics.costUsd?.toFixed(4) ?? '?'}`,
        `Duration: ${(result.metrics.durationMs / 1000).toFixed(1)}s`,
      ].join(' | ')));
    }

    if (result.output) {
      console.log(`\n${result.output}`);
    }
  }
}
