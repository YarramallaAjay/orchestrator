/**
 * In-memory KV store implementation with scope support.
 *
 * M1: In-memory only, agent scope.
 * M2: Will add persistence and full 4-level scoping.
 */

import type { Scope } from '../../platform/types.js';
import type { KVStore, KVStoreScoped, ScopeKey } from './types.js';

type ChangeCallback = (value: string | null, oldValue: string | null) => void;
type AllChangeCallback = (key: string, value: string | null) => void;

export class InMemoryKVStore implements KVStore {
  /** scope:id → key → value */
  private data = new Map<string, Map<string, string>>();

  /** scope:id:key → set of callbacks */
  private keySubscribers = new Map<string, Set<ChangeCallback>>();

  /** scope:id → set of callbacks */
  private scopeSubscribers = new Map<string, Set<AllChangeCallback>>();

  async get(scope: ScopeKey, key: string): Promise<string | null> {
    const bucket = this.getBucket(scope);
    return bucket.get(key) ?? null;
  }

  async set(scope: ScopeKey, key: string, value: string): Promise<void> {
    const bucket = this.getBucket(scope);
    const oldValue = bucket.get(key) ?? null;
    bucket.set(key, value);

    // Notify key subscribers
    const subKey = this.subscriberKey(scope, key);
    const keySubs = this.keySubscribers.get(subKey);
    if (keySubs) {
      for (const cb of keySubs) {
        try { cb(value, oldValue); } catch { /* swallow handler errors */ }
      }
    }

    // Notify scope-level subscribers
    const scopeKey = this.scopeId(scope);
    const scopeSubs = this.scopeSubscribers.get(scopeKey);
    if (scopeSubs) {
      for (const cb of scopeSubs) {
        try { cb(key, value); } catch { /* swallow handler errors */ }
      }
    }
  }

  async delete(scope: ScopeKey, key: string): Promise<void> {
    const bucket = this.getBucket(scope);
    const oldValue = bucket.get(key) ?? null;
    bucket.delete(key);

    // Notify
    const subKey = this.subscriberKey(scope, key);
    const keySubs = this.keySubscribers.get(subKey);
    if (keySubs) {
      for (const cb of keySubs) {
        try { cb(null, oldValue); } catch { /* swallow */ }
      }
    }

    const scopeKey = this.scopeId(scope);
    const scopeSubs = this.scopeSubscribers.get(scopeKey);
    if (scopeSubs) {
      for (const cb of scopeSubs) {
        try { cb(key, null); } catch { /* swallow */ }
      }
    }
  }

  async list(scope: ScopeKey, prefix?: string): Promise<string[]> {
    const bucket = this.getBucket(scope);
    const keys = [...bucket.keys()];
    if (prefix) {
      return keys.filter((k) => k.startsWith(prefix));
    }
    return keys;
  }

  subscribe(
    scope: ScopeKey,
    key: string,
    callback: ChangeCallback,
  ): () => void {
    const subKey = this.subscriberKey(scope, key);
    if (!this.keySubscribers.has(subKey)) {
      this.keySubscribers.set(subKey, new Set());
    }
    this.keySubscribers.get(subKey)!.add(callback);

    return () => {
      this.keySubscribers.get(subKey)?.delete(callback);
    };
  }

  subscribeAll(scope: ScopeKey, callback: AllChangeCallback): () => void {
    const scopeKey = this.scopeId(scope);
    if (!this.scopeSubscribers.has(scopeKey)) {
      this.scopeSubscribers.set(scopeKey, new Set());
    }
    this.scopeSubscribers.get(scopeKey)!.add(callback);

    return () => {
      this.scopeSubscribers.get(scopeKey)?.delete(callback);
    };
  }

  async clear(scope: ScopeKey): Promise<void> {
    const scopeKey = this.scopeId(scope);
    this.data.delete(scopeKey);

    // Clean up subscribers for this scope
    for (const key of this.keySubscribers.keys()) {
      if (key.startsWith(scopeKey + ':')) {
        this.keySubscribers.delete(key);
      }
    }
    this.scopeSubscribers.delete(scopeKey);
  }

  // ─── Scoped handle factory ──────────────────────────────────────────────

  scoped(scope: ScopeKey): KVStoreScoped {
    return {
      get: (key) => this.get(scope, key),
      set: (key, value) => this.set(scope, key, value),
      delete: (key) => this.delete(scope, key),
      list: (prefix) => this.list(scope, prefix),
      subscribe: (key, cb) => this.subscribe(scope, key, cb),
      subscribeAll: (cb) => this.subscribeAll(scope, cb),
    };
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  private getBucket(scope: ScopeKey): Map<string, string> {
    const id = this.scopeId(scope);
    if (!this.data.has(id)) {
      this.data.set(id, new Map());
    }
    return this.data.get(id)!;
  }

  private scopeId(scope: ScopeKey): string {
    return `${scope.scope}:${scope.id ?? '_default'}`;
  }

  private subscriberKey(scope: ScopeKey, key: string): string {
    return `${this.scopeId(scope)}:${key}`;
  }
}
