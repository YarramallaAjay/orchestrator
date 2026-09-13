import { minimatch } from 'minimatch';
import { generateId } from '../util/id.js';
import type { OrchestratorEvent } from './types.js';

export type EventHandler<T extends OrchestratorEvent = OrchestratorEvent> = (
  event: T,
) => void | Promise<void>;

interface Subscription {
  pattern: string;
  handler: EventHandler;
}

/**
 * In-process event bus with wildcard pattern matching on event types.
 * Supports patterns like 'task.*', 'agent.message', or '*' for all events.
 */
export class EventBus {
  private subscriptions: Subscription[] = [];

  /**
   * Publish an event to all matching subscribers.
   */
  async publish(event: OrchestratorEvent): Promise<void> {
    // Ensure event has an id and timestamp
    if (!event.id) event.id = generateId('evt');
    if (!event.timestamp) event.timestamp = new Date().toISOString();

    for (const sub of this.subscriptions) {
      if (sub.pattern === '*' || minimatch(event.type, sub.pattern)) {
        try {
          await sub.handler(event);
        } catch {
          // Swallow subscriber errors to not break the bus
        }
      }
    }
  }

  /**
   * Subscribe to events matching a pattern.
   * Supports glob-style patterns: 'task.*', 'agent.message', '*'
   * Returns an unsubscribe function.
   */
  subscribe<T extends OrchestratorEvent = OrchestratorEvent>(
    pattern: string,
    handler: EventHandler<T>,
  ): () => void {
    const sub: Subscription = {
      pattern,
      handler: handler as EventHandler,
    };
    this.subscriptions.push(sub);

    return () => {
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  /**
   * Wait for the next event matching a pattern.
   */
  once(pattern: string): Promise<OrchestratorEvent> {
    return new Promise((resolve) => {
      const unsub = this.subscribe(pattern, (event) => {
        unsub();
        resolve(event);
      });
    });
  }

  /**
   * Wait for an event matching a pattern and predicate, with optional timeout.
   */
  waitFor(
    pattern: string,
    predicate: (event: OrchestratorEvent) => boolean,
    timeoutMs?: number,
  ): Promise<OrchestratorEvent> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const unsub = this.subscribe(pattern, (event) => {
        if (predicate(event)) {
          unsub();
          if (timer) clearTimeout(timer);
          resolve(event);
        }
      });

      if (timeoutMs) {
        timer = setTimeout(() => {
          unsub();
          reject(new Error(`Timed out waiting for event matching '${pattern}'`));
        }, timeoutMs);
      }
    });
  }

  /**
   * Remove all subscriptions.
   */
  clear(): void {
    this.subscriptions.length = 0;
  }
}
