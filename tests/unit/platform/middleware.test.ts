import { describe, it, expect, beforeEach } from 'vitest';
import { MiddlewareChain, RetryMiddleware, TimeoutMiddleware, LoggingMiddleware } from '../../../src/layer3-engine/middleware/chain.js';
import { PlatformEventBus } from '../../../src/layer2-core/events/event-bus.js';
import { Agent } from '../../../src/layer4-surface/sdk/agent-builder.js';
import { ExecutionStatus } from '../../../src/platform/types.js';
import type { MiddlewareContext, ExecutionResult, Middleware, NextFn } from '../../../src/platform/types.js';

function makeCtx(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  const agent = Agent.create('test-agent')
    .preferences({ maxRetries: 2, timeoutMs: 5000 })
    .build();

  return {
    executionId: 'exec-1',
    agent,
    input: 'test prompt',
    metadata: {},
    ...overrides,
  };
}

const successResult: ExecutionResult = {
  status: ExecutionStatus.COMPLETED,
  output: 'done',
  metrics: { durationMs: 100 },
};

const failResult: ExecutionResult = {
  status: ExecutionStatus.FAILED,
  error: 'something broke',
  metrics: { durationMs: 50 },
};

describe('MiddlewareChain', () => {
  it('should call executor when chain is empty', async () => {
    const chain = new MiddlewareChain();
    const result = await chain.execute(makeCtx(), () => Promise.resolve(successResult));
    expect(result).toEqual(successResult);
  });

  it('should execute middleware in order', async () => {
    const order: string[] = [];

    const mw1: Middleware = {
      name: 'first',
      async execute(_ctx, next) {
        order.push('first-before');
        const r = await next();
        order.push('first-after');
        return r;
      },
    };

    const mw2: Middleware = {
      name: 'second',
      async execute(_ctx, next) {
        order.push('second-before');
        const r = await next();
        order.push('second-after');
        return r;
      },
    };

    const chain = new MiddlewareChain();
    chain.add(mw1);
    chain.add(mw2);

    await chain.execute(makeCtx(), () => {
      order.push('executor');
      return Promise.resolve(successResult);
    });

    expect(order).toEqual(['first-before', 'second-before', 'executor', 'second-after', 'first-after']);
  });

  it('should allow middleware to short-circuit', async () => {
    const shortCircuit: Middleware = {
      name: 'short',
      async execute() {
        return { status: ExecutionStatus.FAILED, error: 'blocked' };
      },
    };

    const chain = new MiddlewareChain();
    chain.add(shortCircuit);

    let executorCalled = false;
    const result = await chain.execute(makeCtx(), () => {
      executorCalled = true;
      return Promise.resolve(successResult);
    });

    expect(result.status).toBe(ExecutionStatus.FAILED);
    expect(executorCalled).toBe(false);
  });
});

describe('RetryMiddleware', () => {
  it('should return immediately on success', async () => {
    const mw = new RetryMiddleware();
    let callCount = 0;

    const result = await mw.execute(makeCtx(), () => {
      callCount++;
      return Promise.resolve(successResult);
    });

    expect(callCount).toBe(1);
    expect(result.status).toBe(ExecutionStatus.COMPLETED);
  });

  it('should retry on failure up to maxRetries', async () => {
    const mw = new RetryMiddleware();
    let callCount = 0;

    const result = await mw.execute(makeCtx(), () => {
      callCount++;
      if (callCount < 3) return Promise.resolve(failResult);
      return Promise.resolve(successResult);
    });

    expect(callCount).toBe(3); // 1 initial + 2 retries
    expect(result.status).toBe(ExecutionStatus.COMPLETED);
  });

  it('should return failure after exhausting retries', async () => {
    const mw = new RetryMiddleware();
    let callCount = 0;

    const result = await mw.execute(makeCtx(), () => {
      callCount++;
      return Promise.resolve(failResult);
    });

    expect(callCount).toBe(3); // 1 initial + 2 retries
    expect(result.status).toBe(ExecutionStatus.FAILED);
  });

  it('should emit retry events to event bus', async () => {
    const bus = new PlatformEventBus();
    const events: any[] = [];
    bus.subscribe('execution.retrying', (e) => events.push(e));

    const mw = new RetryMiddleware(bus);
    await mw.execute(makeCtx(), () => Promise.resolve(failResult));

    expect(events).toHaveLength(2); // 2 retries
  });
});

describe('TimeoutMiddleware', () => {
  it('should pass through if no timeout set', async () => {
    const mw = new TimeoutMiddleware();
    const agent = Agent.create('test').preferences({ timeoutMs: 0 }).build();
    const ctx = makeCtx({ agent });

    const result = await mw.execute(ctx, () => Promise.resolve(successResult));
    expect(result.status).toBe(ExecutionStatus.COMPLETED);
  });

  it('should return failure on timeout', async () => {
    const mw = new TimeoutMiddleware();
    const agent = Agent.create('test').preferences({ timeoutMs: 50 }).build();
    const ctx = makeCtx({ agent });

    const result = await mw.execute(ctx, () =>
      new Promise((resolve) => setTimeout(() => resolve(successResult), 200)),
    );

    expect(result.status).toBe(ExecutionStatus.FAILED);
    expect(result.error).toContain('timed out');
  });

  it('should return result if completed before timeout', async () => {
    const mw = new TimeoutMiddleware();
    const agent = Agent.create('test').preferences({ timeoutMs: 500 }).build();
    const ctx = makeCtx({ agent });

    const result = await mw.execute(ctx, () => Promise.resolve(successResult));
    expect(result.status).toBe(ExecutionStatus.COMPLETED);
  });
});

describe('LoggingMiddleware', () => {
  it('should emit start and completion events', async () => {
    const bus = new PlatformEventBus();
    const events: any[] = [];
    bus.subscribe('agent.*', (e) => events.push(e));

    const mw = new LoggingMiddleware(bus);
    await mw.execute(makeCtx(), () => Promise.resolve(successResult));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent.started');
    expect(events[1].type).toBe('agent.completed');
  });

  it('should emit failure event on error', async () => {
    const bus = new PlatformEventBus();
    const events: any[] = [];
    bus.subscribe('agent.*', (e) => events.push(e));

    const mw = new LoggingMiddleware(bus);
    await mw.execute(makeCtx(), () => Promise.resolve(failResult));

    expect(events[1].type).toBe('agent.failed');
  });
});
