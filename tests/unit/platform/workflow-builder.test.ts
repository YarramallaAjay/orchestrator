import { describe, it, expect } from 'vitest';
import { Workflow } from '../../../src/layer4-surface/sdk/workflow-builder.js';
import { Agent } from '../../../src/layer4-surface/sdk/agent-builder.js';

describe('WorkflowBuilder', () => {
  const agent = Agent.create('worker').runtime('mock').build();

  it('should build a simple workflow', () => {
    const wf = Workflow.create('test')
      .step('a', agent, 'Do A')
      .step('b', agent, 'Do B')
      .cwd('/tmp')
      .build();

    expect(wf.name).toBe('test');
    expect(wf.nodes).toHaveLength(2);
    expect(wf.cwd).toBe('/tmp');
  });

  it('should support dependencies', () => {
    const wf = Workflow.create('deps')
      .step('plan', agent, 'Plan')
      .step('build', agent, 'Build', { dependsOn: ['plan'] })
      .step('test', agent, 'Test', { dependsOn: ['build'] })
      .build();

    expect(wf.nodes[1]!.dependsOn).toEqual(['plan']);
    expect(wf.nodes[2]!.dependsOn).toEqual(['build']);
  });

  it('should support parallel steps', () => {
    const wf = Workflow.create('parallel')
      .step('plan', agent, 'Plan')
      .parallel([
        { name: 'frontend', agent, prompt: 'Build frontend' },
        { name: 'backend', agent, prompt: 'Build backend' },
      ], { dependsOn: ['plan'] })
      .step('deploy', agent, 'Deploy', { dependsOn: ['frontend', 'backend'] })
      .build();

    expect(wf.nodes).toHaveLength(4);
    expect(wf.nodes[1]!.dependsOn).toEqual(['plan']);
    expect(wf.nodes[2]!.dependsOn).toEqual(['plan']);
    expect(wf.nodes[3]!.dependsOn).toEqual(['frontend', 'backend']);
  });

  it('should set constraints', () => {
    const wf = Workflow.create('constrained')
      .step('a', agent, 'Do A')
      .constraints({ maxConcurrent: 5, maxBudgetUsd: 10 })
      .build();

    expect(wf.constraints?.maxConcurrent).toBe(5);
    expect(wf.constraints?.maxBudgetUsd).toBe(10);
  });

  it('should throw on empty workflow', () => {
    expect(() => Workflow.create('empty').build()).toThrow('at least one step');
  });

  it('should throw on invalid dependency', () => {
    expect(() =>
      Workflow.create('bad')
        .step('a', agent, 'Do A', { dependsOn: ['nonexistent'] })
        .build(),
    ).toThrow('does not exist');
  });

  it('should set project ID', () => {
    const wf = Workflow.create('proj')
      .step('a', agent, 'Do A')
      .projectId('proj-1')
      .build();

    expect(wf.projectId).toBe('proj-1');
  });
});
