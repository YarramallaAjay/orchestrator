import { describe, it, expect } from 'vitest';
import { Agent } from '../../../src/layer4-surface/sdk/agent-builder.js';
import { Events } from '../../../src/layer4-surface/sdk/types.js';
import { Scope, AgentSource } from '../../../src/platform/types.js';

describe('Agent Builder', () => {
  it('should create a minimal agent definition', () => {
    const agent = Agent.create('test-agent').build();

    expect(agent.name).toBe('test-agent');
    expect(agent.id).toMatch(/^agent_/);
    expect(agent.source).toBe(AgentSource.CODE);
    expect(agent.capabilities).toEqual([]);
    expect(agent.memory.scope).toBe(Scope.AGENT);
    expect(agent.memory.access).toBe('read-write');
    expect(agent.preferences.maxRetries).toBe(2);
  });

  it('should set runtime', () => {
    const agent = Agent.create('test')
      .runtime('claude-code')
      .build();

    expect(agent.runtime).toBe('claude-code');
  });

  it('should add capabilities', () => {
    const agent = Agent.create('test')
      .capability('file-edit', 'shell')
      .capability('git')
      .build();

    expect(agent.capabilities).toEqual(['file-edit', 'shell', 'git']);
  });

  it('should configure memory', () => {
    const agent = Agent.create('test')
      .memory({ scope: 'workflow', access: 'read-only', subscribe: ['api-schema'] })
      .build();

    expect(agent.memory.scope).toBe(Scope.WORKFLOW);
    expect(agent.memory.access).toBe('read-only');
    expect(agent.memory.subscribe).toEqual(['api-schema']);
  });

  it('should set preferences', () => {
    const agent = Agent.create('test')
      .preferences({ maxRetries: 5, timeoutMs: 60_000, fallbackRuntime: 'api' })
      .build();

    expect(agent.preferences.maxRetries).toBe(5);
    expect(agent.preferences.timeoutMs).toBe(60_000);
    expect(agent.preferences.fallbackRuntime).toBe('api');
  });

  it('should set description and instructions', () => {
    const agent = Agent.create('test')
      .description('A test agent')
      .instructions('Do the thing')
      .build();

    expect(agent.description).toBe('A test agent');
    expect(agent.instructions).toBe('Do the thing');
  });

  it('should configure triggers', () => {
    const agent = Agent.create('test')
      .trigger({ onEvent: 'backend-ready' })
      .build();

    expect(agent.triggers?.onEvent).toBe('backend-ready');
  });

  it('should register event handlers', () => {
    const handler = () => {};
    const agent = Agent.create('test')
      .on(Events.TASK_COMPLETE, handler)
      .on(Events.TASK_FAILED, handler)
      .build();

    const handlers = agent.adapterConfig?._eventHandlers as Map<string, any[]>;
    expect(handlers).toBeDefined();
  });

  it('should chain all builder methods fluently', () => {
    const agent = Agent.create('full-agent')
      .runtime('claude-code')
      .capability('file-edit', 'shell', 'git')
      .memory({ scope: 'workflow', access: 'read-write' })
      .preferences({ maxRetries: 3 })
      .description('Full agent')
      .instructions('Build the backend')
      .trigger({ onEvent: 'plan-approved' })
      .adapterConfig({ model: 'claude-sonnet-4-6' })
      .build();

    expect(agent.name).toBe('full-agent');
    expect(agent.runtime).toBe('claude-code');
    expect(agent.capabilities).toEqual(['file-edit', 'shell', 'git']);
    expect(agent.memory.scope).toBe(Scope.WORKFLOW);
    expect(agent.description).toBe('Full agent');
    expect(agent.instructions).toBe('Build the backend');
    expect(agent.adapterConfig?.model).toBe('claude-sonnet-4-6');
  });
});
