import { describe, it, expect } from 'vitest';
import { PlatformConfigSchema } from '../../../src/platform/config/schema.js';

describe('PlatformConfigSchema', () => {
  it('should parse a minimal config', () => {
    const result = PlatformConfigSchema.parse({
      project: { name: 'test-project' },
    });

    expect(result.project.name).toBe('test-project');
    expect(result.project.root_path).toBe('.');
    expect(result.execution.max_concurrent).toBe(3);
    expect(result.execution.max_budget_usd).toBe(10.0);
    expect(result.execution.auto_retry).toBe(true);
    expect(result.agents).toEqual([]);
    expect(result.runtimes).toEqual([]);
  });

  it('should parse a config with agents', () => {
    const result = PlatformConfigSchema.parse({
      project: { name: 'test' },
      agents: [
        {
          name: 'backend',
          runtime: 'claude-code',
          capabilities: ['file-edit', 'shell'],
        },
      ],
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe('backend');
    expect(result.agents[0].runtime).toBe('claude-code');
    expect(result.agents[0].memory.scope).toBe('agent');
    expect(result.agents[0].memory.access).toBe('read-write');
    expect(result.agents[0].preferences.max_retries).toBe(2);
    expect(result.agents[0].preferences.timeout).toBe('300s');
  });

  it('should parse a config with runtime preferences', () => {
    const result = PlatformConfigSchema.parse({
      project: { name: 'test' },
      runtimes: [
        {
          name: 'claude',
          type: 'claude-code',
          priority: 0,
          capabilities: ['file-edit', 'shell'],
        },
        {
          name: 'openai',
          type: 'api',
          priority: 1,
          config: { base_url: 'https://api.openai.com/v1' },
        },
      ],
    });

    expect(result.runtimes).toHaveLength(2);
    expect(result.runtimes[0].priority).toBe(0);
    expect(result.runtimes[1].config).toHaveProperty('base_url');
  });

  it('should apply all defaults for nested objects', () => {
    const result = PlatformConfigSchema.parse({
      project: { name: 'test' },
    });

    expect(result.memory.kv_backend).toBe('memory');
    expect(result.memory.doc_backend).toBe('sqlite');
    expect(result.database.path).toBe('.orchestrator/data.db');
    expect(result.git.integration_branch).toBe('main');
    expect(result.web.port).toBe(3847);
  });

  it('should reject config without project name', () => {
    expect(() => PlatformConfigSchema.parse({})).toThrow();
    expect(() => PlatformConfigSchema.parse({ project: {} })).toThrow();
  });

  it('should reject invalid agent config', () => {
    expect(() => PlatformConfigSchema.parse({
      project: { name: 'test' },
      agents: [{ runtime: 'claude' }], // missing name
    })).toThrow();
  });
});
