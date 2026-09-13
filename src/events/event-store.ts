import { eq, and, gte, desc } from 'drizzle-orm';
import type { Db } from '../db/connection.js';
import { events } from '../db/schema.js';
import type { OrchestratorEvent } from './types.js';
import type { EventBus } from './event-bus.js';
import { generateId } from '../util/id.js';

/**
 * Persists events from the EventBus to SQLite for history/replay.
 * Subscribes to all events on the bus and writes them asynchronously.
 */
export class EventStore {
  private unsub: (() => void) | null = null;

  constructor(private db: Db) {}

  /**
   * Start persisting all events from the bus.
   */
  attach(bus: EventBus): void {
    this.unsub = bus.subscribe('*', (event) => {
      this.persist(event);
    });
  }

  /**
   * Stop persisting events.
   */
  detach(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
  }

  /**
   * Persist a single event.
   */
  persist(event: OrchestratorEvent): void {
    try {
      this.db.insert(events).values({
        id: event.id || generateId('evt'),
        type: event.type,
        source: event.source,
        projectId: event.projectId,
        payload: JSON.stringify(event.payload),
        correlationId: event.correlationId ?? null,
        timestamp: event.timestamp || new Date().toISOString(),
      }).run();
    } catch {
      // Don't let persistence failures break the event flow
    }
  }

  /**
   * Query event history.
   */
  async query(filter: {
    projectId?: string;
    type?: string;
    since?: string;
    limit?: number;
  }): Promise<OrchestratorEvent[]> {
    let query = this.db.select().from(events);

    const conditions = [];
    if (filter.projectId) {
      conditions.push(eq(events.projectId, filter.projectId));
    }
    if (filter.type) {
      conditions.push(eq(events.type, filter.type));
    }
    if (filter.since) {
      conditions.push(gte(events.timestamp, filter.since));
    }

    const rows = conditions.length > 0
      ? this.db.select().from(events).where(and(...conditions)).orderBy(desc(events.timestamp)).limit(filter.limit ?? 100).all()
      : this.db.select().from(events).orderBy(desc(events.timestamp)).limit(filter.limit ?? 100).all();

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      source: row.source,
      projectId: row.projectId,
      payload: JSON.parse(row.payload),
      correlationId: row.correlationId ?? undefined,
      timestamp: row.timestamp,
    }));
  }

  /**
   * Count events by type for a project.
   */
  async countByType(projectId: string): Promise<Record<string, number>> {
    const rows = this.db
      .select()
      .from(events)
      .where(eq(events.projectId, projectId))
      .all();

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.type] = (counts[row.type] ?? 0) + 1;
    }
    return counts;
  }
}
