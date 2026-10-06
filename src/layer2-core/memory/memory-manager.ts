/**
 * Memory manager -- provides scoped access to KV and document stores.
 *
 * Wires together the two-tier memory model and provides cleanup
 * for ephemeral scopes (workflow + agent) when workflows complete.
 */

import { Scope } from '../../platform/types.js';
import type { MemoryManager, KVStoreScoped, DocumentStoreScoped, ScopeKey } from './types.js';
import { InMemoryKVStore } from './kv-store.js';
import { InMemoryDocumentStore } from './doc-store.js';

export class DefaultMemoryManager implements MemoryManager {
  private kvStore: InMemoryKVStore;
  private docStore: InMemoryDocumentStore;

  /** Track which scopes are associated with which workflow for cleanup. */
  private workflowScopes = new Map<string, ScopeKey[]>();

  constructor(kvStore?: InMemoryKVStore, docStore?: InMemoryDocumentStore) {
    this.kvStore = kvStore ?? new InMemoryKVStore();
    this.docStore = docStore ?? new InMemoryDocumentStore();
  }

  kv(scope: ScopeKey): KVStoreScoped {
    return this.kvStore.scoped(scope);
  }

  docs(scope: ScopeKey): DocumentStoreScoped {
    return this.docStore.scoped(scope);
  }

  /**
   * Register a scope as belonging to a workflow, so it gets cleaned up
   * when the workflow completes.
   */
  registerWorkflowScope(workflowId: string, scope: ScopeKey): void {
    if (!this.workflowScopes.has(workflowId)) {
      this.workflowScopes.set(workflowId, []);
    }
    this.workflowScopes.get(workflowId)!.push(scope);
  }

  /**
   * Clean up all ephemeral scopes (workflow + agent) for a workflow.
   * Global and project scopes are preserved.
   */
  async cleanupWorkflow(workflowId: string): Promise<void> {
    // Clean the workflow-level scope
    const workflowScope: ScopeKey = { scope: Scope.WORKFLOW, id: workflowId };
    await this.kvStore.clear(workflowScope);
    await this.docStore.clear(workflowScope);

    // Clean any registered agent scopes
    const scopes = this.workflowScopes.get(workflowId) ?? [];
    for (const scope of scopes) {
      if (scope.scope === Scope.AGENT || scope.scope === Scope.WORKFLOW) {
        await this.kvStore.clear(scope);
        await this.docStore.clear(scope);
      }
    }

    this.workflowScopes.delete(workflowId);
  }

  /**
   * Create scoped memory handles for an agent within a workflow.
   * The agent gets:
   * - its own agent-scoped KV and doc stores
   * - read access to workflow-scoped stores
   */
  createAgentMemory(
    workflowId: string,
    agentId: string,
    access: 'read-only' | 'read-write',
  ): { kv: KVStoreScoped; docs: DocumentStoreScoped; workflowKv: KVStoreScoped; workflowDocs: DocumentStoreScoped } {
    const agentScope: ScopeKey = { scope: Scope.AGENT, id: agentId };
    const workflowScope: ScopeKey = { scope: Scope.WORKFLOW, id: workflowId };

    // Register for cleanup
    this.registerWorkflowScope(workflowId, agentScope);

    const agentKv = this.kvStore.scoped(agentScope);
    const agentDocs = this.docStore.scoped(agentScope);
    const workflowKv = this.kvStore.scoped(workflowScope);
    const workflowDocs = this.docStore.scoped(workflowScope);

    if (access === 'read-only') {
      // Wrap workflow stores to be read-only
      return {
        kv: agentKv,
        docs: agentDocs,
        workflowKv: readOnlyKv(workflowKv),
        workflowDocs: readOnlyDocs(workflowDocs),
      };
    }

    return { kv: agentKv, docs: agentDocs, workflowKv, workflowDocs };
  }

  /** Expose raw stores for testing or advanced use. */
  getRawKvStore(): InMemoryKVStore {
    return this.kvStore;
  }

  getRawDocStore(): InMemoryDocumentStore {
    return this.docStore;
  }
}

// ─── Read-Only Wrappers ─────────────────────────────────────────────────────

function readOnlyKv(store: KVStoreScoped): KVStoreScoped {
  return {
    get: (key) => store.get(key),
    set: () => { throw new Error('Cannot write to read-only KV store'); },
    delete: () => { throw new Error('Cannot delete from read-only KV store'); },
    list: (prefix) => store.list(prefix),
    subscribe: (key, cb) => store.subscribe(key, cb),
    subscribeAll: (cb) => store.subscribeAll(cb),
  };
}

function readOnlyDocs(store: DocumentStoreScoped): DocumentStoreScoped {
  return {
    get: (key) => store.get(key),
    set: () => { throw new Error('Cannot write to read-only document store'); },
    list: (category) => store.list(category),
    delete: () => { throw new Error('Cannot delete from read-only document store'); },
    search: (query) => store.search(query),
  };
}
