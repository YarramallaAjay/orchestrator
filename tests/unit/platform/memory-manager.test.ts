import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultMemoryManager } from '../../../src/layer2-core/memory/memory-manager.js';
import { Scope } from '../../../src/platform/types.js';

describe('DefaultMemoryManager', () => {
  let mm: DefaultMemoryManager;

  beforeEach(() => {
    mm = new DefaultMemoryManager();
  });

  it('should provide scoped KV access', async () => {
    const kv = mm.kv({ scope: Scope.PROJECT, id: 'proj-1' });
    await kv.set('key', 'value');
    expect(await kv.get('key')).toBe('value');
  });

  it('should provide scoped doc access', async () => {
    const docs = mm.docs({ scope: Scope.PROJECT, id: 'proj-1' });
    const doc = await docs.set({ key: 'k', category: 'c', title: 'T', content: 'body' });
    expect(doc.key).toBe('k');
    expect(await docs.get('k')).toEqual(doc);
  });

  it('should create agent memory handles', async () => {
    const { kv, docs, workflowKv, workflowDocs } = mm.createAgentMemory('wf-1', 'agent-1', 'read-write');

    // Agent can write to its own scope
    await kv.set('private', 'data');
    expect(await kv.get('private')).toBe('data');

    // Agent can write to workflow scope
    await workflowKv.set('shared', 'value');
    expect(await workflowKv.get('shared')).toBe('value');

    // Another agent sees workflow data
    const { workflowKv: wk2 } = mm.createAgentMemory('wf-1', 'agent-2', 'read-write');
    expect(await wk2.get('shared')).toBe('value');
  });

  it('should enforce read-only on workflow stores', async () => {
    const { workflowKv, workflowDocs } = mm.createAgentMemory('wf-1', 'agent-1', 'read-only');

    await expect(async () => workflowKv.set('key', 'val')).rejects.toThrow('read-only');
    await expect(async () => workflowKv.delete('key')).rejects.toThrow('read-only');
    await expect(async () => workflowDocs.set({ key: 'k', category: 'c', title: 'T', content: '' })).rejects.toThrow('read-only');
    await expect(async () => workflowDocs.delete('k')).rejects.toThrow('read-only');
  });

  it('should allow reads on read-only workflow stores', async () => {
    // Pre-populate workflow data
    const wfKv = mm.kv({ scope: Scope.WORKFLOW, id: 'wf-1' });
    await wfKv.set('data', 'accessible');

    const { workflowKv } = mm.createAgentMemory('wf-1', 'agent-1', 'read-only');
    expect(await workflowKv.get('data')).toBe('accessible');
  });

  it('should clean up workflow and agent scopes', async () => {
    mm.createAgentMemory('wf-1', 'agent-1', 'read-write');
    mm.createAgentMemory('wf-1', 'agent-2', 'read-write');

    // Write data
    const agentKv = mm.kv({ scope: Scope.AGENT, id: 'agent-1' });
    await agentKv.set('key', 'value');

    const wfKv = mm.kv({ scope: Scope.WORKFLOW, id: 'wf-1' });
    await wfKv.set('shared', 'data');

    // Clean up
    await mm.cleanupWorkflow('wf-1');

    // Data is gone
    expect(await agentKv.get('key')).toBeNull();
    expect(await wfKv.get('shared')).toBeNull();
  });

  it('should not clean up project scope on workflow cleanup', async () => {
    const projKv = mm.kv({ scope: Scope.PROJECT, id: 'proj-1' });
    await projKv.set('persistent', 'data');

    await mm.cleanupWorkflow('wf-1');

    expect(await projKv.get('persistent')).toBe('data');
  });

  it('should isolate different workflow scopes', async () => {
    const { workflowKv: wk1 } = mm.createAgentMemory('wf-1', 'agent-1', 'read-write');
    const { workflowKv: wk2 } = mm.createAgentMemory('wf-2', 'agent-2', 'read-write');

    await wk1.set('key', 'from-wf1');
    await wk2.set('key', 'from-wf2');

    expect(await wk1.get('key')).toBe('from-wf1');
    expect(await wk2.get('key')).toBe('from-wf2');
  });
});
