import { describe, it, expect } from 'vitest';
import { parseYamlAgent, parseMarkdownAgent } from '../../../src/layer4-surface/agent-loader/parser.js';
import { Scope, AgentSource } from '../../../src/platform/types.js';

describe('parseYamlAgent', () => {
  it('should parse a minimal agent config', () => {
    const agent = parseYamlAgent({ name: 'worker' });

    expect(agent.name).toBe('worker');
    expect(agent.id).toMatch(/^agent_/);
    expect(agent.source).toBe(AgentSource.YAML);
    expect(agent.capabilities).toEqual([]);
    expect(agent.memory.scope).toBe(Scope.AGENT);
    expect(agent.memory.access).toBe('read-write');
    expect(agent.preferences.maxRetries).toBe(2);
    expect(agent.preferences.timeoutMs).toBe(300_000);
  });

  it('should parse a full agent config', () => {
    const agent = parseYamlAgent({
      name: 'backend-dev',
      description: 'Backend developer agent',
      runtime: 'claude-code',
      capabilities: ['file-edit', 'shell', 'git'],
      memory: {
        scope: 'workflow',
        access: 'read-write',
        subscribe: ['api-schema'],
      },
      preferences: {
        max_retries: 3,
        timeout: '10m',
        fallback_runtime: 'api',
      },
      instructions: 'Build the backend API',
      steps: [
        { name: 'design', description: 'Design the API schema' },
        { name: 'implement', description: 'Implement endpoints', depends_on: ['design'] },
      ],
      triggers: {
        on_event: 'plan-approved',
      },
      config: { model: 'claude-sonnet-4-6' },
    });

    expect(agent.name).toBe('backend-dev');
    expect(agent.description).toBe('Backend developer agent');
    expect(agent.runtime).toBe('claude-code');
    expect(agent.capabilities).toEqual(['file-edit', 'shell', 'git']);
    expect(agent.memory.scope).toBe(Scope.WORKFLOW);
    expect(agent.memory.subscribe).toEqual(['api-schema']);
    expect(agent.preferences.maxRetries).toBe(3);
    expect(agent.preferences.timeoutMs).toBe(600_000); // 10m
    expect(agent.preferences.fallbackRuntime).toBe('api');
    expect(agent.instructions).toBe('Build the backend API');
    expect(agent.steps).toHaveLength(2);
    expect(agent.steps![1]!.dependsOn).toEqual(['design']);
    expect(agent.triggers?.onEvent).toBe('plan-approved');
    expect(agent.adapterConfig?.model).toBe('claude-sonnet-4-6');
  });

  it('should reject config without name', () => {
    expect(() => parseYamlAgent({})).toThrow();
  });
});

describe('parseMarkdownAgent', () => {
  it('should parse a markdown agent with frontmatter', () => {
    const content = `---
name: doc-writer
runtime: api
capabilities: [text-generation]
---

# Documentation Writer

Write comprehensive documentation for the codebase.

## Steps

1. **Scan Codebase**: Analyze the project structure
2. **Write Docs**: Generate documentation for each module
3. **Review**: Self-review the generated documentation
`;

    const agent = parseMarkdownAgent(content);

    expect(agent.name).toBe('doc-writer');
    expect(agent.source).toBe(AgentSource.DESCRIPTIVE);
    expect(agent.runtime).toBe('api');
    expect(agent.capabilities).toEqual(['text-generation']);
    expect(agent.instructions).toContain('Documentation Writer');
    expect(agent.instructions).toContain('Write comprehensive documentation');
    expect(agent.steps).toHaveLength(3);
    expect(agent.steps![0]!.name).toBe('Scan Codebase');
    expect(agent.steps![1]!.name).toBe('Write Docs');
  });

  it('should handle agent without steps section', () => {
    const content = `---
name: simple-agent
---

Just do the task as described.
`;

    const agent = parseMarkdownAgent(content);
    expect(agent.name).toBe('simple-agent');
    expect(agent.instructions).toBe('Just do the task as described.');
    expect(agent.steps).toBeUndefined();
  });

  it('should reject content without frontmatter', () => {
    expect(() => parseMarkdownAgent('No frontmatter here')).toThrow('frontmatter');
  });
});
