import { describe, it, expect, beforeEach } from 'vitest';
import { PlatformEventBus, createEvent } from '../../../src/layer2-core/events/event-bus.js';
import type { PlatformEvent } from '../../../src/layer2-core/events/types.js';

describe('PlatformEventBus', () => {
  let bus: PlatformEventBus;

  beforeEach(() => {
    bus = new PlatformEventBus();
  });

  function makeEvent(type: string): PlatformEvent {
    return createEvent(type, 'test', { data: 'test' });
  }

  it('should deliver events to exact-match subscribers', async () => {
    const received: PlatformEvent[] = [];
    bus.subscribe('agent.completed', (e) => { received.push(e); });

    await bus.publish(makeEvent('agent.completed'));
    expect(received).toHaveLength(1);
  });

  it('should support single-segment wildcard (*)', async () => {
    const received: PlatformEvent[] = [];
    bus.subscribe('agent.*', (e) => { received.push(e); });

    await bus.publish(makeEvent('agent.completed'));
    await bus.publish(makeEvent('agent.failed'));
    await bus.publish(makeEvent('workflow.started'));

    expect(received).toHaveLength(2);
  });

  it('should support catch-all pattern (*)', async () => {
    const received: PlatformEvent[] = [];
    bus.subscribe('*', (e) => { received.push(e); });

    await bus.publish(makeEvent('agent.completed'));
    await bus.publish(makeEvent('workflow.started'));

    expect(received).toHaveLength(2);
  });

  it('should support double-wildcard (**)', async () => {
    const received: PlatformEvent[] = [];
    bus.subscribe('agent.**', (e) => { received.push(e); });

    await bus.publish(makeEvent('agent.completed'));
    await bus.publish(makeEvent('agent.task.done'));
    await bus.publish(makeEvent('workflow.started'));

    expect(received).toHaveLength(2);
  });

  it('should not match unrelated events', async () => {
    const received: PlatformEvent[] = [];
    bus.subscribe('agent.completed', (e) => { received.push(e); });

    await bus.publish(makeEvent('agent.failed'));
    expect(received).toHaveLength(0);
  });

  it('should unsubscribe correctly', async () => {
    const received: PlatformEvent[] = [];
    const unsub = bus.subscribe('agent.*', (e) => { received.push(e); });

    await bus.publish(makeEvent('agent.completed'));
    unsub();
    await bus.publish(makeEvent('agent.failed'));

    expect(received).toHaveLength(1);
  });

  it('should support once() -- fire handler only once', async () => {
    const received: PlatformEvent[] = [];
    bus.once('agent.completed', (e) => { received.push(e); });

    await bus.publish(makeEvent('agent.completed'));
    await bus.publish(makeEvent('agent.completed'));

    expect(received).toHaveLength(1);
  });

  it('should support waitFor() with timeout', async () => {
    const promise = bus.waitFor('agent.completed', 1000);
    const event = makeEvent('agent.completed');
    await bus.publish(event);
    const result = await promise;
    expect(result.type).toBe('agent.completed');
  });

  it('should reject waitFor() on timeout', async () => {
    await expect(bus.waitFor('never.happens', 50)).rejects.toThrow('Timed out');
  });

  it('should clear all subscribers', async () => {
    const received: PlatformEvent[] = [];
    bus.subscribe('agent.*', (e) => { received.push(e); });
    bus.clear();

    await bus.publish(makeEvent('agent.completed'));
    expect(received).toHaveLength(0);
  });
});
