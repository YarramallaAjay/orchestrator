import { Command } from 'commander';
import chalk from 'chalk';
import { EventBus } from '../../events/event-bus.js';
import { startWebServer } from '../../web/server.js';
import { loadProjectContext } from '../helpers.js';

export const serveCommand = new Command('serve')
  .description('Start the web dashboard')
  .option('-p, --port <port>', 'Port number')
  .option('-h, --host <host>', 'Host to bind to')
  .action(async (options) => {
    const ctx = loadProjectContext();
    const eventBus = new EventBus();

    const port = options.port ? parseInt(options.port) : ctx.config.web.port;
    const host = options.host ?? ctx.config.web.host;

    console.log(chalk.bold('Starting web dashboard...'));

    const app = await startWebServer({
      db: ctx.db,
      projectId: ctx.projectId,
      eventBus,
      config: {
        port,
        host,
        rootPath: ctx.rootPath,
        git: ctx.config.git,
      },
    });

    console.log(chalk.green(`Dashboard running at http://${host}:${port}`));
    console.log(chalk.dim('Press Ctrl+C to stop'));

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log(chalk.yellow('\nShutting down...'));
      await app.close();
      process.exit(0);
    });
  });
