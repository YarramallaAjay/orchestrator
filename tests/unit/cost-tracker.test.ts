import { describe, it, expect, beforeEach } from 'vitest';
import { CostTracker } from '../../src/core/cost-tracker.js';
import { EventBus } from '../../src/events/event-bus.js';

describe('CostTracker', () => {
  let tracker: CostTracker;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    tracker = new CostTracker(10.0, eventBus);
  });

  it('should record costs', () => {
    tracker.record('agent1', 'task1', 0.5);
    tracker.record('agent1', 'task2', 0.3);
    tracker.record('agent2', 'task3', 0.2);

    const summary = tracker.getSummary();
    expect(summary.totalUsd).toBe(1.0);
    expect(summary.byAgent['agent1']).toBe(0.8);
    expect(summary.byAgent['agent2']).toBe(0.2);
    expect(summary.byTask['task1']).toBe(0.5);
  });

  it('should track remaining budget', () => {
    tracker.record('a', 't', 3.0);
    expect(tracker.remainingBudget()).toBe(7.0);
    expect(tracker.isOverBudget()).toBe(false);
  });

  it('should detect budget exceeded', () => {
    tracker.record('a', 't', 11.0);
    expect(tracker.isOverBudget()).toBe(true);
    expect(tracker.remainingBudget()).toBe(0);
  });

  it('should emit budget exceeded event', async () => {
    const events: any[] = [];
    eventBus.subscribe('budget.exceeded', (e) => events.push(e));

    tracker.record('a', 't', 15.0);
    // Give async event time to propagate
    await new Promise((r) => setTimeout(r, 10));

    expect(events).toHaveLength(1);
    expect(events[0].payload.excess).toBe(5.0);
  });

  it('should reset costs', () => {
    tracker.record('a', 't', 5.0);
    tracker.reset();
    expect(tracker.getSummary().totalUsd).toBe(0);
  });
});
