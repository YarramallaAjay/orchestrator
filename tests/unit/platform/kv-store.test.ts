import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryKVStore } from '../../../src/layer2-core/memory/kv-store.js';
import { Scope } from '../../../src/platform/types.js';

describe('InMemoryKVStore', () => {
  let kv: InMemoryKVStore;
  const scope = { scope: Scope.AGENT, id: 'agent-1' };

  beforeEach(() => {
    kv = new InMemoryKVStore();
  });

  it('should get and set values', async () => {
    await kv.set(scope, 'key1', 'value1');
    const result = await kv.get(scope, 'key1');
    expect(result).toBe('value1');
  });

  it('should return null for missing keys', async () => {
    const result = await kv.get(scope, 'nonexistent');
    expect(result).toBeNull();
  });

  it('should delete keys', async () => {
    await kv.set(scope, 'key1', 'value1');
    await kv.delete(scope, 'key1');
    const result = await kv.get(scope, 'key1');
    expect(result).toBeNull();
  });

  it('should list keys', async () => {
    await kv.set(scope, 'foo:a', '1');
    await kv.set(scope, 'foo:b', '2');
    await kv.set(scope, 'bar:c', '3');

    const all = await kv.list(scope);
    expect(all).toHaveLength(3);

    const fooKeys = await kv.list(scope, 'foo:');
    expect(fooKeys).toHaveLength(2);
  });

  it('should isolate scopes', async () => {
    const scope1 = { scope: Scope.AGENT, id: 'agent-1' };
    const scope2 = { scope: Scope.AGENT, id: 'agent-2' };

    await kv.set(scope1, 'key', 'from-agent-1');
    await kv.set(scope2, 'key', 'from-agent-2');

    expect(await kv.get(scope1, 'key')).toBe('from-agent-1');
    expect(await kv.get(scope2, 'key')).toBe('from-agent-2');
  });

  it('should notify key subscribers on set', async () => {
    const changes: Array<{ value: string | null; old: string | null }> = [];
    kv.subscribe(scope, 'watched', (value, old) => {
      changes.push({ value, old });
    });

    await kv.set(scope, 'watched', 'first');
    await kv.set(scope, 'watched', 'second');

    expect(changes).toEqual([
      { value: 'first', old: null },
      { value: 'second', old: 'first' },
    ]);
  });

  it('should notify key subscribers on delete', async () => {
    await kv.set(scope, 'key', 'value');

    const changes: Array<{ value: string | null; old: string | null }> = [];
    kv.subscribe(scope, 'key', (value, old) => {
      changes.push({ value, old });
    });

    await kv.delete(scope, 'key');
    expect(changes).toEqual([{ value: null, old: 'value' }]);
  });

  it('should unsubscribe correctly', async () => {
    const changes: string[] = [];
    const unsub = kv.subscribe(scope, 'key', (value) => {
      changes.push(value ?? 'null');
    });

    await kv.set(scope, 'key', 'first');
    unsub();
    await kv.set(scope, 'key', 'second');

    expect(changes).toEqual(['first']);
  });

  it('should notify scope-level subscribers', async () => {
    const changes: Array<{ key: string; value: string | null }> = [];
    kv.subscribeAll(scope, (key, value) => {
      changes.push({ key, value });
    });

    await kv.set(scope, 'a', '1');
    await kv.set(scope, 'b', '2');

    expect(changes).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });

  it('should clear a scope', async () => {
    await kv.set(scope, 'key1', 'v1');
    await kv.set(scope, 'key2', 'v2');

    await kv.clear(scope);

    expect(await kv.get(scope, 'key1')).toBeNull();
    expect(await kv.get(scope, 'key2')).toBeNull();
    expect(await kv.list(scope)).toHaveLength(0);
  });

  it('should provide a scoped handle', async () => {
    const handle = kv.scoped(scope);

    await handle.set('key', 'value');
    expect(await handle.get('key')).toBe('value');
    expect(await handle.list()).toEqual(['key']);

    await handle.delete('key');
    expect(await handle.get('key')).toBeNull();
  });
});
