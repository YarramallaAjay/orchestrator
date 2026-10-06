/**
 * In-memory document store implementation.
 *
 * Provides rich document storage with versioning, categories,
 * and basic text search. Scoped to 4 levels: global/project/workflow/agent.
 *
 * M2: In-memory implementation.
 * Future: SQLite or external store backend.
 */

import { nanoid } from 'nanoid';
import type { DocumentStore, DocumentStoreScoped, ScopeKey, Document, DocumentInput } from './types.js';

export class InMemoryDocumentStore implements DocumentStore {
  /** scope:id → key → Document */
  private data = new Map<string, Map<string, Document>>();

  async get(scope: ScopeKey, key: string): Promise<Document | null> {
    const bucket = this.getBucket(scope);
    return bucket.get(key) ?? null;
  }

  async set(scope: ScopeKey, doc: DocumentInput): Promise<Document> {
    const bucket = this.getBucket(scope);
    const existing = bucket.get(doc.key);
    const now = new Date().toISOString();

    const document: Document = {
      id: existing?.id ?? `doc_${nanoid(8)}`,
      key: doc.key,
      category: doc.category,
      title: doc.title,
      content: doc.content,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      updatedBy: doc.updatedBy,
      metadata: doc.metadata,
    };

    bucket.set(doc.key, document);
    return document;
  }

  async list(scope: ScopeKey, category?: string): Promise<Document[]> {
    const bucket = this.getBucket(scope);
    const docs = [...bucket.values()];
    if (category) {
      return docs.filter((d) => d.category === category);
    }
    return docs;
  }

  async delete(scope: ScopeKey, key: string): Promise<void> {
    const bucket = this.getBucket(scope);
    bucket.delete(key);
  }

  async search(scope: ScopeKey, query: string): Promise<Document[]> {
    const bucket = this.getBucket(scope);
    const lower = query.toLowerCase();
    return [...bucket.values()].filter(
      (d) =>
        d.title.toLowerCase().includes(lower) ||
        d.content.toLowerCase().includes(lower) ||
        d.key.toLowerCase().includes(lower),
    );
  }

  async clear(scope: ScopeKey): Promise<void> {
    const scopeKey = this.scopeId(scope);
    this.data.delete(scopeKey);
  }

  // ─── Scoped handle factory ──────────────────────────────────────────────

  scoped(scope: ScopeKey): DocumentStoreScoped {
    return {
      get: (key) => this.get(scope, key),
      set: (doc) => this.set(scope, doc),
      list: (category) => this.list(scope, category),
      delete: (key) => this.delete(scope, key),
      search: (query) => this.search(scope, query),
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private getBucket(scope: ScopeKey): Map<string, Document> {
    const id = this.scopeId(scope);
    if (!this.data.has(id)) {
      this.data.set(id, new Map());
    }
    return this.data.get(id)!;
  }

  private scopeId(scope: ScopeKey): string {
    return `${scope.scope}:${scope.id ?? '_default'}`;
  }
}
