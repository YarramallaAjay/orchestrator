import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDocumentStore } from '../../../src/layer2-core/memory/doc-store.js';
import { Scope } from '../../../src/platform/types.js';
import type { ScopeKey } from '../../../src/layer2-core/memory/types.js';

describe('InMemoryDocumentStore', () => {
  let store: InMemoryDocumentStore;
  const scope: ScopeKey = { scope: Scope.PROJECT, id: 'proj-1' };

  beforeEach(() => {
    store = new InMemoryDocumentStore();
  });

  it('should create and retrieve a document', async () => {
    const doc = await store.set(scope, {
      key: 'architecture',
      category: 'design',
      title: 'Architecture',
      content: 'The system has four layers.',
    });

    expect(doc.id).toMatch(/^doc_/);
    expect(doc.version).toBe(1);
    expect(doc.key).toBe('architecture');

    const fetched = await store.get(scope, 'architecture');
    expect(fetched).toEqual(doc);
  });

  it('should update and increment version', async () => {
    await store.set(scope, {
      key: 'readme',
      category: 'docs',
      title: 'README',
      content: 'v1',
    });

    const updated = await store.set(scope, {
      key: 'readme',
      category: 'docs',
      title: 'README',
      content: 'v2',
      updatedBy: 'agent-1',
    });

    expect(updated.version).toBe(2);
    expect(updated.content).toBe('v2');
    expect(updated.updatedBy).toBe('agent-1');
  });

  it('should return null for missing docs', async () => {
    const result = await store.get(scope, 'nonexistent');
    expect(result).toBeNull();
  });

  it('should list all documents', async () => {
    await store.set(scope, { key: 'a', category: 'design', title: 'A', content: '...' });
    await store.set(scope, { key: 'b', category: 'code', title: 'B', content: '...' });

    const all = await store.list(scope);
    expect(all).toHaveLength(2);
  });

  it('should list documents by category', async () => {
    await store.set(scope, { key: 'a', category: 'design', title: 'A', content: '...' });
    await store.set(scope, { key: 'b', category: 'code', title: 'B', content: '...' });
    await store.set(scope, { key: 'c', category: 'design', title: 'C', content: '...' });

    const design = await store.list(scope, 'design');
    expect(design).toHaveLength(2);
  });

  it('should delete documents', async () => {
    await store.set(scope, { key: 'temp', category: 'misc', title: 'Temp', content: '...' });
    await store.delete(scope, 'temp');

    const result = await store.get(scope, 'temp');
    expect(result).toBeNull();
  });

  it('should search by content', async () => {
    await store.set(scope, { key: 'a', category: 'design', title: 'Auth', content: 'JWT tokens for authentication' });
    await store.set(scope, { key: 'b', category: 'design', title: 'DB', content: 'PostgreSQL database' });

    const results = await store.search(scope, 'jwt');
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe('a');
  });

  it('should search by title', async () => {
    await store.set(scope, { key: 'a', category: 'design', title: 'Authentication Flow', content: '...' });
    await store.set(scope, { key: 'b', category: 'design', title: 'Database Schema', content: '...' });

    const results = await store.search(scope, 'auth');
    expect(results).toHaveLength(1);
  });

  it('should isolate scopes', async () => {
    const scope1: ScopeKey = { scope: Scope.PROJECT, id: 'proj-1' };
    const scope2: ScopeKey = { scope: Scope.PROJECT, id: 'proj-2' };

    await store.set(scope1, { key: 'doc', category: 'a', title: 'A', content: 'from proj-1' });
    await store.set(scope2, { key: 'doc', category: 'a', title: 'A', content: 'from proj-2' });

    const doc1 = await store.get(scope1, 'doc');
    const doc2 = await store.get(scope2, 'doc');

    expect(doc1!.content).toBe('from proj-1');
    expect(doc2!.content).toBe('from proj-2');
  });

  it('should clear a scope', async () => {
    await store.set(scope, { key: 'a', category: 'x', title: 'A', content: '...' });
    await store.set(scope, { key: 'b', category: 'x', title: 'B', content: '...' });

    await store.clear(scope);

    const docs = await store.list(scope);
    expect(docs).toHaveLength(0);
  });

  it('should provide a scoped handle', async () => {
    const handle = store.scoped(scope);

    const doc = await handle.set({ key: 'k', category: 'c', title: 'T', content: 'body' });
    expect(doc.key).toBe('k');

    const fetched = await handle.get('k');
    expect(fetched!.content).toBe('body');

    const list = await handle.list();
    expect(list).toHaveLength(1);

    const search = await handle.search('body');
    expect(search).toHaveLength(1);

    await handle.delete('k');
    expect(await handle.get('k')).toBeNull();
  });
});
