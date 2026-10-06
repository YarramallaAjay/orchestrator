/**
 * Middleware chain -- wraps execution with cross-cutting concerns.
 *
 * Middleware executes in order, each calling next() to continue.
 * Built-in middleware: retry, timeout, logging.
 */

import type { Middleware, MiddlewareContext, NextFn, ExecutionResult } from '../../platform/types.js';
import { ExecutionStatus } from '../../platform/types.js';
import type { EventBus } from '../../layer2-core/events/types.js';
import { EventTypes } from '../../layer2-core/events/types.js';
import { createEvent } from '../../layer2-core/events/event-bus.js';

// ─── Middleware Chain ───────────────────────────────────────────────────────

export class MiddlewareChain {
  private middleware: Middleware[] = [];

  add(mw: Middleware): void {
    this.middleware.push(mw);
  }

  /**
   * Execute the chain. The innermost next() calls the actual executor.
   */
  async execute(ctx: MiddlewareContext, executor: NextFn): Promise<ExecutionResult> {
    const chain = [...this.middleware];

    const run = (index: number): Promise<ExecutionResult> => {
      if (index >= chain.length) {
        return executor();
      }
      return chain[index]!.execute(ctx, () => run(index + 1));
    };

    return run(0);
  }
}

// ─── Built-in Middleware ────────────────────────────────────────────────────

/**
 * Retry middleware -- retries failed executions up to maxRetries times.
 */
export class RetryMiddleware implements Middleware {
  name = 'retry';

  constructor(private eventBus?: EventBus) {}

  async execute(ctx: MiddlewareContext, next: NextFn): Promise<ExecutionResult> {
    const maxRetries = ctx.agent.preferences.maxRetries;
    let lastResult: ExecutionResult | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      ctx.metadata.attempt = attempt;
      lastResult = await next();

      if (lastResult.status === ExecutionStatus.COMPLETED) {
        return lastResult;
      }

      if (attempt < maxRetries + 1) {
        // Emit retry event
        if (this.eventBus) {
          await this.eventBus.publish(
            createEvent(EventTypes.EXECUTION_RETRYING, 'middleware.retry', {
              executionId: ctx.executionId,
              agentId: ctx.agent.id,
              attempt,
              maxRetries,
              error: lastResult.error,
            }, {
              projectId: ctx.projectId,
              workflowId: ctx.workflowId,
              agentId: ctx.agent.id,
            }),
          );
        }

        ctx.metadata.retryFeedback = `Attempt ${attempt} failed: ${lastResult.error}. Please try a different approach.`;
      }
    }

    return lastResult!;
  }
}

/**
 * Timeout middleware -- cancels execution if it exceeds the timeout.
 */
export class TimeoutMiddleware implements Middleware {
  name = 'timeout';

  async execute(ctx: MiddlewareContext, next: NextFn): Promise<ExecutionResult> {
    const timeoutMs = ctx.agent.preferences.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      return next();
    }

    return new Promise<ExecutionResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({
            status: ExecutionStatus.FAILED,
            error: `Execution timed out after ${timeoutMs}ms`,
          });
        }
      }, timeoutMs);

      next().then((result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      }).catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            status: ExecutionStatus.FAILED,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });
  }
}

/**
 * Logging middleware -- emits lifecycle events for observability.
 */
export class LoggingMiddleware implements Middleware {
  name = 'logging';

  constructor(private eventBus: EventBus) {}

  async execute(ctx: MiddlewareContext, next: NextFn): Promise<ExecutionResult> {
    const startTime = Date.now();

    await this.eventBus.publish(
      createEvent(EventTypes.AGENT_STARTED, 'middleware.logging', {
        executionId: ctx.executionId,
        agentId: ctx.agent.id,
        agentName: ctx.agent.name,
      }, {
        projectId: ctx.projectId,
        workflowId: ctx.workflowId,
        agentId: ctx.agent.id,
      }),
    );

    const result = await next();
    const durationMs = Date.now() - startTime;

    const eventType = result.status === ExecutionStatus.COMPLETED
      ? EventTypes.AGENT_COMPLETED
      : EventTypes.AGENT_FAILED;

    await this.eventBus.publish(
      createEvent(eventType, 'middleware.logging', {
        executionId: ctx.executionId,
        agentId: ctx.agent.id,
        agentName: ctx.agent.name,
        status: result.status,
        durationMs,
        metrics: result.metrics,
        error: result.error,
      }, {
        projectId: ctx.projectId,
        workflowId: ctx.workflowId,
        agentId: ctx.agent.id,
      }),
    );

    return result;
  }
}
