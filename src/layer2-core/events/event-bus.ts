/**
 * Event bus implementation with glob-style pattern matching.
 *
 * Reshaped from the existing EventBus -- same core logic,
 * updated to use the new PlatformEvent type.
 */

import { nanoid } from 'nanoid';
import type { EventBus, EventHandler, PlatformEvent } from './types.js';

export class PlatformEventBus implements EventBus {
  private subscribers = new Map<string, Set<EventHandler>>();
  private onceHandlers = new Set<EventHandler>();

  async publish(event: PlatformEvent): Promise<void> {
    for (const [pattern, handlers] of this.subscribers) {
      if (matchesPattern(event.type, pattern)) {
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch {
            // Swallow handler errors to prevent one handler from breaking others
          }

          // Remove once-handlers after firing
          if (this.onceHandlers.has(handler)) {
            handlers.delete(handler);
            this.onceHandlers.delete(handler);
          }
        }
      }
    }
  }

  subscribe(pattern: string, handler: EventHandler): () => void {
    if (!this.subscribers.has(pattern)) {
      this.subscribers.set(pattern, new Set());
    }
    this.subscribers.get(pattern)!.add(handler);

    return () => {
      this.subscribers.get(pattern)?.delete(handler);
      if (this.subscribers.get(pattern)?.size === 0) {
        this.subscribers.delete(pattern);
      }
    };
  }

  once(pattern: string, handler: EventHandler): () => void {
    this.onceHandlers.add(handler);
    return this.subscribe(pattern, handler);
  }

  waitFor(pattern: string, timeoutMs: number = 30_000): Promise<PlatformEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Timed out waiting for event matching '${pattern}'`));
      }, timeoutMs);

      const unsub = this.once(pattern, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  }

  clear(): void {
    this.subscribers.clear();
    this.onceHandlers.clear();
  }
}

/**
 * Match an event type against a glob-like pattern.
 *
 * Supported patterns:
 *   - 'agent.completed' — exact match
 *   - 'agent.*' — matches one segment (agent.completed, agent.failed)
 *   - 'agent.**' — matches any depth (agent.completed, agent.task.done)
 *   - '*' — matches everything
 */
function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === eventType) return true;

  const patternParts = pattern.split('.');
  const typeParts = eventType.split('.');

  let pi = 0;
  let ti = 0;

  while (pi < patternParts.length && ti < typeParts.length) {
    const pp = patternParts[pi];

    if (pp === '**') {
      // ** matches zero or more segments
      if (pi === patternParts.length - 1) return true;
      // Try matching remaining pattern at each position
      for (let i = ti; i <= typeParts.length; i++) {
        if (matchesPattern(typeParts.slice(i).join('.'), patternParts.slice(pi + 1).join('.'))) {
          return true;
        }
      }
      return false;
    }

    if (pp === '*') {
      // * matches exactly one segment
      pi++;
      ti++;
      continue;
    }

    if (pp !== typeParts[ti]) {
      return false;
    }

    pi++;
    ti++;
  }

  return pi === patternParts.length && ti === typeParts.length;
}

/**
 * Helper to create a PlatformEvent.
 */
export function createEvent(
  type: string,
  source: string,
  payload: Record<string, unknown> = {},
  extra: Partial<PlatformEvent> = {},
): PlatformEvent {
  return {
    id: `evt_${nanoid(12)}`,
    type,
    source,
    timestamp: new Date().toISOString(),
    payload,
    ...extra,
  };
}
