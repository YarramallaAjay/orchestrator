import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../src/events/event-bus.js';
import type { OrchestratorEvent } from '../../src/events/types.js';

function makeEvent(type: string, overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: `evt_${Date.now()}`,
    type,
    source: 'test',
    timestamp: new Date().toISOString(),
    projectId: 'proj_test',
    payload: {},
    ...overrides,
  };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('should deliver events to matching subscribers', async () => {
    const received: OrchestratorEvent[] = [];
    bus.subscribe('task.created', (event) => {
      received.push(event);
    });

    await bus.publish(makeEvent('task.created'));
    expect(received).toHaveLength(1);
  });

  it('should support wildcard patterns', async () => {
    const received: OrchestratorEvent[] = [];
    bus.subscribe('task.*', (event) => {
      received.push(event);
    });

    await bus.publish(makeEvent('task.created'));
    await bus.publish(makeEvent('task.state_changed'));
    await bus.publish(makeEvent('agent.message'));

    expect(received).toHaveLength(2);
  });

  it('should support catch-all pattern', async () => {
    const received: OrchestratorEvent[] = [];
    bus.subscribe('*', (event) => {
      received.push(event);
    });

    await bus.publish(makeEvent('task.created'));
    await bus.publish(makeEvent('agent.message'));

    expect(received).toHaveLength(2);
  });

  it('should unsubscribe correctly', async () => {
    const received: OrchestratorEvent[] = [];
    const unsub = bus.subscribe('task.*', (event) => {
      received.push(event);
    });

    await bus.publish(makeEvent('task.created'));
    unsub();
    await bus.publish(makeEvent('task.created'));

    expect(received).toHaveLength(1);
  });

  it('should resolve once() on first matching event', async () => {
    const promise = bus.once('task.created');
    await bus.publish(makeEvent('task.created', { payload: { test: true } }));

    const event = await promise;
    expect(event.type).toBe('task.created');
  });

  it('should resolve waitFor() when predicate matches', async () => {
    const promise = bus.waitFor(
      'task.*',
      (event) => (event.payload as any).taskId === '123',
    );

    await bus.publish(makeEvent('task.created', { payload: { taskId: '456' } }));
    await bus.publish(makeEvent('task.created', { payload: { taskId: '123' } }));

    const event = await promise;
    expect((event.payload as any).taskId).toBe('123');
  });

  it('should reject waitFor() on timeout', async () => {
    const promise = bus.waitFor(
      'never.happens',
      () => true,
      50,
    );

    await expect(promise).rejects.toThrow('Timed out');
  });

  it('should clear all subscriptions', async () => {
    const received: OrchestratorEvent[] = [];
    bus.subscribe('*', (event) => {
      received.push(event);
    });

    bus.clear();
    await bus.publish(makeEvent('task.created'));

    expect(received).toHaveLength(0);
  });

  it('should not crash on subscriber errors', async () => {
    bus.subscribe('task.*', () => {
      throw new Error('subscriber error');
    });

    // Should not throw
    await bus.publish(makeEvent('task.created'));
  });
});
