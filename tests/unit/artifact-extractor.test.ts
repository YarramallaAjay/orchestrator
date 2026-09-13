import { describe, it, expect } from 'vitest';
import { ArtifactExtractor } from '../../src/core/artifact-extractor.js';
import type { AgentRunResult, AgentMessage } from '../../src/agent/runtimes/runtime.js';

function makeResult(messages: AgentMessage[]): AgentRunResult {
  return {
    success: true,
    messages,
    outputArtifacts: {},
    totalCostUsd: 0,
    turnsUsed: 1,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    sessionId: null,
  };
}

function makeToolMsg(toolName: string, input: Record<string, any>): AgentMessage {
  return {
    role: 'assistant',
    content: `[Tool: ${toolName}]`,
    toolUse: { name: toolName, input },
    timestamp: new Date().toISOString(),
  };
}

function makeTextMsg(content: string): AgentMessage {
  return {
    role: 'assistant',
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('ArtifactExtractor', () => {
  const extractor = new ArtifactExtractor();

  it('should extract file_created artifacts from Write tool calls', () => {
    const result = makeResult([
      makeToolMsg('Write', { file_path: '/src/index.ts' }),
      makeToolMsg('Write', { file_path: '/src/utils.ts' }),
    ]);

    const artifacts = extractor.extract(result);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.type).toBe('file_created');
    expect(artifacts[0]!.path).toBe('/src/index.ts');
    expect(artifacts[1]!.type).toBe('file_created');
    expect(artifacts[1]!.path).toBe('/src/utils.ts');
  });

  it('should extract file_modified artifacts from Edit tool calls', () => {
    const result = makeResult([
      makeToolMsg('Edit', { file_path: '/src/config.ts' }),
    ]);

    const artifacts = extractor.extract(result);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.type).toBe('file_modified');
    expect(artifacts[0]!.path).toBe('/src/config.ts');
  });

  it('should deduplicate files', () => {
    const result = makeResult([
      makeToolMsg('Write', { file_path: '/src/index.ts' }),
      makeToolMsg('Edit', { file_path: '/src/index.ts' }),
    ]);

    const artifacts = extractor.extract(result);

    // First occurrence wins (Write)
    expect(artifacts.filter((a) => a.path === '/src/index.ts')).toHaveLength(1);
    expect(artifacts[0]!.type).toBe('file_created');
  });

  it('should extract decisions from assistant messages', () => {
    const result = makeResult([
      makeTextMsg('I decided to use Fastify instead of Express for better performance.'),
    ]);

    const artifacts = extractor.extract(result);
    const decisions = artifacts.filter((a) => a.type === 'decision');

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.summary).toContain('Fastify');
  });

  it('should return empty array for no tool calls', () => {
    const result = makeResult([
      makeTextMsg('Just thinking about the code...'),
    ]);

    const artifacts = extractor.extract(result);
    const files = artifacts.filter((a) => a.type === 'file_created' || a.type === 'file_modified');

    expect(files).toHaveLength(0);
  });

  it('should format artifacts for downstream context', () => {
    const result = makeResult([
      makeToolMsg('Write', { file_path: '/src/db.ts' }),
      makeToolMsg('Edit', { file_path: '/src/config.ts' }),
    ]);

    const artifacts = extractor.extract(result);
    const formatted = extractor.formatForDownstream('Setup database', artifacts);

    expect(formatted).toContain('Upstream Task: Setup database');
    expect(formatted).toContain('Created: `/src/db.ts`');
    expect(formatted).toContain('Modified: `/src/config.ts`');
  });

  it('should return empty string when no artifacts', () => {
    const formatted = extractor.formatForDownstream('Empty task', []);
    expect(formatted).toBe('');
  });
});
