import { eq, and } from 'drizzle-orm';
import type { Db } from '../db/connection.js';
import { contextEntries, contextHistory } from '../db/schema.js';
import { generateId } from '../util/id.js';
import type { ContextEntry, ContextCategory } from './types.js';

export class ContextRepository {
  constructor(private db: Db) {}

  async set(entry: {
    projectId: string;
    key: string;
    category: ContextCategory;
    title: string;
    content: string;
    updatedBy: string;
  }): Promise<ContextEntry> {
    const now = new Date().toISOString();
    const existing = await this.get(entry.projectId, entry.key);

    if (existing) {
      // Save current version to history
      this.db.insert(contextHistory).values({
        id: generateId('ctxh'),
        entryId: existing.id,
        version: existing.version,
        content: existing.content,
        updatedBy: existing.updatedBy,
        createdAt: now,
      }).run();

      // Update entry
      this.db.update(contextEntries).set({
        title: entry.title,
        content: entry.content,
        category: entry.category,
        version: existing.version + 1,
        updatedBy: entry.updatedBy,
        updatedAt: now,
      }).where(eq(contextEntries.id, existing.id)).run();

      return (await this.get(entry.projectId, entry.key))!;
    }

    const id = generateId('ctx');
    this.db.insert(contextEntries).values({
      id,
      projectId: entry.projectId,
      key: entry.key,
      category: entry.category,
      title: entry.title,
      content: entry.content,
      version: 1,
      updatedBy: entry.updatedBy,
      createdAt: now,
      updatedAt: now,
    }).run();

    return (await this.getById(id))!;
  }

  async get(projectId: string, key: string): Promise<ContextEntry | null> {
    const rows = this.db
      .select()
      .from(contextEntries)
      .where(and(eq(contextEntries.projectId, projectId), eq(contextEntries.key, key)))
      .all();
    return rows[0] ? this.rowToEntry(rows[0]) : null;
  }

  async getById(id: string): Promise<ContextEntry | null> {
    const rows = this.db.select().from(contextEntries).where(eq(contextEntries.id, id)).all();
    return rows[0] ? this.rowToEntry(rows[0]) : null;
  }

  async list(projectId: string, category?: ContextCategory): Promise<ContextEntry[]> {
    if (category) {
      return this.db
        .select()
        .from(contextEntries)
        .where(and(eq(contextEntries.projectId, projectId), eq(contextEntries.category, category)))
        .all()
        .map(this.rowToEntry);
    }
    return this.db
      .select()
      .from(contextEntries)
      .where(eq(contextEntries.projectId, projectId))
      .all()
      .map(this.rowToEntry);
  }

  async delete(projectId: string, key: string): Promise<void> {
    const entry = await this.get(projectId, key);
    if (entry) {
      this.db.delete(contextEntries).where(eq(contextEntries.id, entry.id)).run();
    }
  }

  async getHistory(projectId: string, key: string): Promise<Array<{ version: number; content: string; updatedBy: string; createdAt: string }>> {
    const entry = await this.get(projectId, key);
    if (!entry) return [];

    return this.db
      .select()
      .from(contextHistory)
      .where(eq(contextHistory.entryId, entry.id))
      .all()
      .map((row) => ({
        version: row.version,
        content: row.content,
        updatedBy: row.updatedBy,
        createdAt: row.createdAt,
      }));
  }

  private rowToEntry(row: typeof contextEntries.$inferSelect): ContextEntry {
    return {
      id: row.id,
      projectId: row.projectId,
      key: row.key,
      category: row.category as ContextCategory,
      title: row.title,
      content: row.content,
      version: row.version,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
