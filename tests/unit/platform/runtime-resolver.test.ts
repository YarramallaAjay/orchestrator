import { describe, it, expect } from 'vitest';
import { RuntimeResolver } from '../../../src/layer3-engine/runtime-resolver.js';
import { AdapterRegistry } from '../../../src/layer1-adapters/adapter-registry.js';
import { Agent } from '../../../src/layer4-surface/sdk/agent-builder.js';
import type { RuntimeAdapter, AdapterConfig, ExecutionInput, RuntimeEvent, RuntimeState } from '../../../src/layer1-adapters/types.js';

// Simple mock adapters with different capabilities
class MockClaudeAdapter implements RuntimeAdapter {
  readonly type = 'claude-code';
  readonly capabilities = ['file-edit', 'shell', 'git', 'reasoning'];
  async initialize() {}
  async *execute(): AsyncGenerator<RuntimeEvent, void, undefined> {}
  async cancel() {}
  status(): RuntimeState { return 'idle'; }
}

class MockApiAdapter implements RuntimeAdapter {
  readonly type = 'api';
  readonly capabilities = ['text-generation', 'reasoning'];
  async initialize() {}
  async *execute(): AsyncGenerator<RuntimeEvent, void, undefined> {}
  async cancel() {}
  status(): RuntimeState { return 'idle'; }
}

class MockCliAdapter implements RuntimeAdapter {
  readonly type = 'cli';
  readonly capabilities = ['shell', 'file-system', 'deployment'];
  async initialize() {}
  async *execute(): AsyncGenerator<RuntimeEvent, void, undefined> {}
  async cancel() {}
  status(): RuntimeState { return 'idle'; }
}

function createRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register('claude-code', () => new MockClaudeAdapter());
  registry.register('api', () => new MockApiAdapter());
  registry.register('cli', () => new MockCliAdapter());
  return registry;
}

describe('RuntimeResolver', () => {
  it('should use explicitly specified runtime', () => {
    const registry = createRegistry();
    const resolver = new RuntimeResolver(registry);
    const agent = Agent.create('test').runtime('api').build();

    expect(resolver.resolve(agent)).toBe('api');
  });

  it('should match by capabilities', () => {
    const registry = createRegistry();
    const resolver = new RuntimeResolver(registry);

    const agent = Agent.create('test')
      .capability('text-generation')
      .build();

    expect(resolver.resolve(agent)).toBe('api');
  });

  it('should prefer user-defined preference order', () => {
    const registry = createRegistry();
    const resolver = new RuntimeResolver(registry, [
      { name: 'api-pref', type: 'api', priority: 0, capabilities: ['reasoning'] },
      { name: 'claude-pref', type: 'claude-code', priority: 1, capabilities: ['reasoning'] },
    ]);

    const agent = Agent.create('test')
      .capability('reasoning')
      .build();

    // Should pick 'api' because it has higher priority (lower number)
    expect(resolver.resolve(agent)).toBe('api');
  });

  it('should fall back to agent fallback runtime', () => {
    const registry = createRegistry();
    const resolver = new RuntimeResolver(registry);

    const agent = Agent.create('test')
      .capability('nonexistent-capability')
      .preferences({ fallbackRuntime: 'cli' })
      .build();

    expect(resolver.resolve(agent)).toBe('cli');
  });

  it('should fall back to default runtime', () => {
    const registry = createRegistry();
    const resolver = new RuntimeResolver(registry);

    const agent = Agent.create('test').build();

    expect(resolver.resolve(agent)).toBe('claude-code');
  });

  it('should allow setting custom default', () => {
    const registry = createRegistry();
    const resolver = new RuntimeResolver(registry);
    resolver.setDefault('api');

    const agent = Agent.create('test').build();
    expect(resolver.resolve(agent)).toBe('api');
  });

  it('should match agent needing multiple capabilities', () => {
    const registry = createRegistry();
    const resolver = new RuntimeResolver(registry);

    const agent = Agent.create('test')
      .capability('file-edit', 'shell')
      .build();

    // Only claude-code has both file-edit and shell
    expect(resolver.resolve(agent)).toBe('claude-code');
  });
});
