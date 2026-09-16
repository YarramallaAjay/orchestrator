import { eq, and, like, desc, sql } from 'drizzle-orm';
import { memories } from '../db/schema.js';
import type { Db } from '../db/connection.js';
import { generateId } from '../util/id.js';

export interface MemoryEntry {
  id: string;
  projectId: string;
  category: string;
  key: string;
  content: string;
  confidence: number;
  source: string;
  lastAccessedAt: string;
  accessCount: number;
  createdAt: string;
}

export interface RecallOptions {
  category?: string;
  query?: string;
  limit?: number;
}

/**
 * Cross-session memory persistence.
 * Stores knowledge that persists across wrapped harness sessions —
 * conventions, patterns, decisions, preferences, and warnings.
 */
export class MemoryStore {
  constructor(private db: Db) {}

  async store(entry: {
    projectId: string;
    category: string;
    key: string;
    content: string;
    confidence?: number;
    source: string;
  }): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const id = generateId('mem');

    // Check for existing entry with same key to update instead of duplicate
    const existing = this.db
      .select()
      .from(memories)
      .where(and(
        eq(memories.projectId, entry.projectId),
        eq(memories.key, entry.key),
      ))
      .get();

    if (existing) {
      // Update existing entry with higher confidence
      const newConfidence = Math.max(existing.confidence, entry.confidence ?? 0.5);
      this.db
        .update(memories)
        .set({
          content: entry.content,
          confidence: newConfidence,
          source: entry.source,
          lastAccessedAt: now,
          accessCount: existing.accessCount + 1,
        })
        .where(eq(memories.id, existing.id))
        .run();

      return { ...existing, content: entry.content, confidence: newConfidence, lastAccessedAt: now };
    }

    const row = {
      id,
      projectId: entry.projectId,
      category: entry.category,
      key: entry.key,
      content: entry.content,
      confidence: entry.confidence ?? 0.5,
      source: entry.source,
      lastAccessedAt: now,
      accessCount: 0,
      createdAt: now,
    };

    this.db.insert(memories).values(row).run();
    return row;
  }

  async recall(projectId: string, opts?: RecallOptions): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? 20;
    const conditions = [eq(memories.projectId, projectId)];

    if (opts?.category) {
      conditions.push(eq(memories.category, opts.category));
    }

    if (opts?.query) {
      // Simple keyword matching on key and content
      conditions.push(
        sql`(${memories.key} LIKE ${'%' + opts.query + '%'} OR ${memories.content} LIKE ${'%' + opts.query + '%'})`,
      );
    }

    const results = this.db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.confidence), desc(memories.accessCount))
      .limit(limit)
      .all();

    // Update lastAccessedAt for recalled entries
    const now = new Date().toISOString();
    for (const entry of results) {
      this.db
        .update(memories)
        .set({
          lastAccessedAt: now,
          accessCount: entry.accessCount + 1,
        })
        .where(eq(memories.id, entry.id))
        .run();
    }

    return results;
  }

  async prune(projectId: string, maxAgeDays = 90): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    const result = this.db
      .delete(memories)
      .where(and(
        eq(memories.projectId, projectId),
        sql`${memories.lastAccessedAt} < ${cutoff}`,
      ))
      .run();

    return result.changes;
  }

  /**
   * Promote a high-confidence observation to a memory entry.
   */
  async promote(observation: {
    projectId: string;
    type: string;
    content: string;
    confidence: number;
    source: string;
  }): Promise<MemoryEntry | null> {
    if (observation.confidence < 0.7) return null;

    // Generate a key from the content (first 50 chars, slugified)
    const key = observation.content
      .slice(0, 50)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return this.store({
      projectId: observation.projectId,
      category: observation.type,
      key,
      content: observation.content,
      confidence: observation.confidence,
      source: observation.source,
    });
  }

  /**
   * Format recalled memories as markdown context for hook injection.
   */
  formatForContext(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';

    const lines = ['## Cross-Session Memory\n'];
    const byCategory = new Map<string, MemoryEntry[]>();

    for (const entry of entries) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }

    for (const [category, items] of byCategory) {
      lines.push(`### ${category}`);
      for (const item of items) {
        lines.push(`- **${item.key}**: ${item.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
