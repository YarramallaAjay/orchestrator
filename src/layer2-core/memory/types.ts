/**
 * Layer 2: Memory subsystem interfaces.
 *
 * Two-tier memory model:
 * - KV Store: fast coordination (locks, signals, small state)
 * - Document Store: rich context (requirements, architecture, API contracts)
 *
 * Both support four scope levels: global, project, workflow, agent.
 */

import type { Scope } from '../../platform/types.js';

// ─── KV Store ───────────────────────────────────────────────────────────────

/**
 * Fast key-value store for inter-agent coordination.
 *
 * Used for signals ("I'm done with file X"), locks, small state,
 * and reactive subscriptions.
 */
export interface KVStore {
  /**
   * Get a value by key within a scope.
   */
  get(scope: ScopeKey, key: string): Promise<string | null>;

  /**
   * Set a value. Emits a change event that subscribers receive.
   */
  set(scope: ScopeKey, key: string, value: string): Promise<void>;

  /**
   * Delete a key.
   */
  delete(scope: ScopeKey, key: string): Promise<void>;

  /**
   * List all keys matching an optional prefix.
   */
  list(scope: ScopeKey, prefix?: string): Promise<string[]>;

  /**
   * Subscribe to changes on a key. Returns an unsubscribe function.
   */
  subscribe(
    scope: ScopeKey,
    key: string,
    callback: (value: string | null, oldValue: string | null) => void,
  ): () => void;

  /**
   * Subscribe to all changes within a scope. Returns an unsubscribe function.
   */
  subscribeAll(
    scope: ScopeKey,
    callback: (key: string, value: string | null) => void,
  ): () => void;

  /**
   * Clear all keys in a scope. Used for cleanup after workflow/agent completion.
   */
  clear(scope: ScopeKey): Promise<void>;
}

/**
 * Fully-qualified scope key that identifies a specific scope instance.
 */
export interface ScopeKey {
  scope: Scope;
  /** For project/workflow/agent scopes, the specific instance ID. */
  id?: string;
}

// ─── Document Store ─────────────────────────────────────────────────────────

/**
 * Rich document store for structured context.
 *
 * Used for requirements, architecture decisions, API contracts,
 * conventions, and other heavy context that agents need to do their work.
 */
export interface DocumentStore {
  /**
   * Get a document by key within a scope.
   */
  get(scope: ScopeKey, key: string): Promise<Document | null>;

  /**
   * Set (create or update) a document.
   */
  set(scope: ScopeKey, doc: DocumentInput): Promise<Document>;

  /**
   * List documents, optionally filtered by category.
   */
  list(scope: ScopeKey, category?: string): Promise<Document[]>;

  /**
   * Delete a document by key.
   */
  delete(scope: ScopeKey, key: string): Promise<void>;

  /**
   * Search documents by content (basic text search).
   */
  search(scope: ScopeKey, query: string): Promise<Document[]>;

  /**
   * Clear all documents in a scope.
   */
  clear(scope: ScopeKey): Promise<void>;
}

export interface Document {
  id: string;
  key: string;
  category: string;
  title: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentInput {
  key: string;
  category: string;
  title: string;
  content: string;
  updatedBy?: string;
  metadata?: Record<string, unknown>;
}

// ─── Memory Manager ────────────────────────────────────────────────────────

/**
 * Top-level memory manager that provides scoped access to both stores.
 */
export interface MemoryManager {
  /** Get a KV store handle scoped to the given scope. */
  kv(scope: ScopeKey): KVStoreScoped;

  /** Get a document store handle scoped to the given scope. */
  docs(scope: ScopeKey): DocumentStoreScoped;

  /** Clean up all ephemeral scopes (workflow + agent) for a workflow. */
  cleanupWorkflow(workflowId: string): Promise<void>;
}

/**
 * A KV store handle pre-scoped to a specific scope.
 * Agents interact with this -- they don't need to pass scope on every call.
 */
export interface KVStoreScoped {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  subscribe(key: string, callback: (value: string | null, oldValue: string | null) => void): () => void;
  subscribeAll(callback: (key: string, value: string | null) => void): () => void;
}

/**
 * A document store handle pre-scoped to a specific scope.
 */
export interface DocumentStoreScoped {
  get(key: string): Promise<Document | null>;
  set(doc: DocumentInput): Promise<Document>;
  list(category?: string): Promise<Document[]>;
  delete(key: string): Promise<void>;
  search(query: string): Promise<Document[]>;
}
