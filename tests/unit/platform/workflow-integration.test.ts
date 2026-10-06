/**
 * M2 Integration test: exercises the full workflow pipeline.
 *
 * DAG scheduler → execution engine → memory → events → middleware
 *
 * Uses a mock runtime adapter to avoid spawning real processes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { nanoid } from 'nanoid';
import { AdapterRegistry } from '../../../src/layer1-adapters/adapter-registry.js';
import type { RuntimeAdapter, AdapterConfig, RuntimeEvent, ExecutionInput, RuntimeState } from '../../../src/layer1-adapters/types.js';
import { PlatformEventBus } from '../../../src/layer2-core/events/event-bus.js';
import { ExecutionEngine } from '../../../src/layer3-engine/execution/engine.js';
import { WorkflowOrchestrator } from '../../../src/layer3-engine/composition/workflow-orchestrator.js';
import { PipelineRunner } from '../../../src/layer3-engine/composition/pipeline-runner.js';
import { MiddlewareChain, RetryMiddleware, LoggingMiddleware } from '../../../src/layer3-engine/middleware/chain.js';
import { DefaultMemoryManager } from '../../../src/layer2-core/memory/memory-manager.js';
import { Agent } from '../../../src/layer4-surface/sdk/agent-builder.js';
import { ExecutionStatus, Scope } from '../../../src/platform/types.js';
import type { PlatformEvent } from '../../../src/layer2-core/events/types.js';

// ─── Mock Runtime Adapter ───────────────────────────────────────────────────

class MockAdapter implements RuntimeAdapter {
  readonly type = 'mock';
  readonly capabilities = ['test'];
  private state: RuntimeState = 'idle';
  private shouldFail: boolean;
  private output: string;
  private delayMs: number;

  constructor(opts?: { shouldFail?: boolean; output?: string; delayMs?: number }) {
    this.shouldFail = opts?.shouldFail ?? false;
    this.output = opts?.output ?? 'mock output';
    this.delayMs = opts?.delayMs ?? 0;
  }

  async initialize(_config: AdapterConfig): Promise<void> {
    this.state = 'idle';
  }

  async *execute(_input: ExecutionInput): AsyncGenerator<RuntimeEvent, void, undefined> {
    this.state = 'running';

    yield {
      type: 'progress',
      message: 'Working...',
      percent: 50,
      timestamp: new Date().toISOString(),
    };

    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    this.state = this.shouldFail ? 'failed' : 'completed';

    yield {
      type: 'done',
      result: {
        success: !this.shouldFail,
        output: this.shouldFail ? 'mock error' : this.output,
        metrics: {
          durationMs: 100,
          costUsd: 0.01,
          inputTokens: 500,
          outputTokens: 200,
          toolCalls: 2,
          turns: 1,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  async cancel(): Promise<void> {
    this.state = 'cancelled';
  }

  status(): RuntimeState {
    return this.state;
  }
}

// ─── Test Setup ─────────────────────────────────────────────────────────────

function createTestStack(opts?: { shouldFail?: boolean; output?: string }) {
  const registry = new AdapterRegistry();
  registry.register('mock', () => new MockAdapter(opts));

  const eventBus = new PlatformEventBus();
  const engine = new ExecutionEngine(registry, eventBus);
  const memoryManager = new DefaultMemoryManager();

  return { registry, eventBus, engine, memoryManager };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('M2 Integration: Workflow Orchestrator', () => {
  it('should execute a simple DAG workflow', async () => {
    const { eventBus, engine, memoryManager } = createTestStack({ output: 'task done' });
    const orchestrator = new WorkflowOrchestrator(engine, eventBus, memoryManager);

    const agent = Agent.create('worker').runtime('mock').build();

    const result = await orchestrator.run({
      name: 'test-workflow',
      cwd: '/tmp',
      nodes: [
        { name: 'step-1', agent, prompt: 'Do step 1' },
        { name: 'step-2', agent, prompt: 'Do step 2' },
      ],
    });

    expect(result.status).toBe(ExecutionStatus.COMPLETED);
    expect(result.nodeResults.size).toBe(2);
  });

  it('should respect dependency ordering', async () => {
    const { eventBus, engine } = createTestStack({ output: 'done' });
    const orchestrator = new WorkflowOrchestrator(engine, eventBus);

    const agentA = Agent.create('first').runtime('mock').build();
    const agentB = Agent.create('second').runtime('mock').build();
    const completedOrder: string[] = [];

    eventBus.subscribe('execution.completed', (e) => {
      completedOrder.push(e.agentId ?? 'unknown');
    });

    const result = await orchestrator.run({
      name: 'dep-workflow',
      cwd: '/tmp',
      nodes: [
        { id: 'a', name: 'first', agent: agentA, prompt: 'First' },
        { id: 'b', name: 'second', agent: agentB, prompt: 'Second', dependsOn: ['a'] },
      ],
      constraints: { maxConcurrent: 1 },
    });

    expect(result.status).toBe(ExecutionStatus.COMPLETED);
    // agentA must complete before agentB
    const idxA = completedOrder.indexOf(agentA.id);
    const idxB = completedOrder.indexOf(agentB.id);
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
  });

  it('should handle failed nodes and cascade cancel', async () => {
    const { eventBus, engine } = createTestStack({ shouldFail: true });
    const orchestrator = new WorkflowOrchestrator(engine, eventBus);

    const agent = Agent.create('worker').runtime('mock').preferences({ maxRetries: 0 }).build();

    const result = await orchestrator.run({
      name: 'fail-workflow',
      cwd: '/tmp',
      nodes: [
        { id: 'a', name: 'failing-task', agent, prompt: 'Fail' },
        { id: 'b', name: 'blocked-task', agent, prompt: 'Never runs', dependsOn: ['a'] },
      ],
    });

    expect(result.status).toBe(ExecutionStatus.FAILED);
    // Only the failing node produced a result
    expect(result.nodeResults.size).toBe(1);
  });

  it('should emit lifecycle events', async () => {
    const { eventBus, engine } = createTestStack({ output: 'done' });
    const orchestrator = new WorkflowOrchestrator(engine, eventBus);
    const events: PlatformEvent[] = [];

    eventBus.subscribe('workflow.*', (e) => events.push(e));

    const agent = Agent.create('worker').runtime('mock').build();

    await orchestrator.run({
      name: 'event-workflow',
      cwd: '/tmp',
      nodes: [{ name: 'task', agent, prompt: 'Do it' }],
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('workflow.started');
    expect(types).toContain('workflow.completed');
  });

  it('should aggregate metrics across nodes', async () => {
    const { eventBus, engine } = createTestStack({ output: 'done' });
    const orchestrator = new WorkflowOrchestrator(engine, eventBus);

    const agent = Agent.create('worker').runtime('mock').build();

    const result = await orchestrator.run({
      name: 'metrics-workflow',
      cwd: '/tmp',
      nodes: [
        { name: 'a', agent, prompt: 'A' },
        { name: 'b', agent, prompt: 'B' },
        { name: 'c', agent, prompt: 'C' },
      ],
    });

    expect(result.metrics.costUsd).toBe(0.03); // 3 * 0.01
    expect(result.metrics.inputTokens).toBe(1500); // 3 * 500
  });
});

describe('M2 Integration: Pipeline Runner', () => {
  it('should execute steps sequentially', async () => {
    const { eventBus, engine } = createTestStack({ output: 'pipeline output' });
    const runner = new PipelineRunner(engine, eventBus);

    const agent = Agent.create('worker').runtime('mock').build();

    const result = await runner.run({
      name: 'test-pipeline',
      cwd: '/tmp',
      steps: [
        { name: 'step-1', agent, prompt: 'First step' },
        { name: 'step-2', agent, prompt: 'Second step with {{previous}}' },
      ],
    });

    expect(result.status).toBe(ExecutionStatus.COMPLETED);
    expect(result.stepResults).toHaveLength(2);
    expect(result.output).toBe('pipeline output');
  });

  it('should stop on step failure', async () => {
    const { eventBus, engine } = createTestStack({ shouldFail: true });
    const runner = new PipelineRunner(engine, eventBus);

    const agent = Agent.create('worker').runtime('mock').preferences({ maxRetries: 0 }).build();

    const result = await runner.run({
      name: 'fail-pipeline',
      cwd: '/tmp',
      steps: [
        { name: 'step-1', agent, prompt: 'Will fail' },
        { name: 'step-2', agent, prompt: 'Never runs' },
      ],
    });

    expect(result.status).toBe(ExecutionStatus.FAILED);
    expect(result.stepResults).toHaveLength(1);
  });

  it('should aggregate pipeline metrics', async () => {
    const { eventBus, engine } = createTestStack({ output: 'done' });
    const runner = new PipelineRunner(engine, eventBus);

    const agent = Agent.create('worker').runtime('mock').build();

    const result = await runner.run({
      name: 'metrics-pipeline',
      cwd: '/tmp',
      steps: [
        { name: 'a', agent, prompt: 'A' },
        { name: 'b', agent, prompt: 'B' },
      ],
    });

    expect(result.metrics.costUsd).toBe(0.02);
    expect(result.metrics.turns).toBe(2);
  });
});

describe('M2 Integration: Middleware + Workflow', () => {
  it('should apply middleware chain to workflow execution', async () => {
    const { eventBus, engine, memoryManager } = createTestStack({ output: 'done' });

    const chain = new MiddlewareChain();
    chain.add(new LoggingMiddleware(eventBus));

    const orchestrator = new WorkflowOrchestrator(engine, eventBus, memoryManager, chain);
    const agentEvents: PlatformEvent[] = [];
    eventBus.subscribe('agent.*', (e) => agentEvents.push(e));

    const agent = Agent.create('worker').runtime('mock').build();

    const result = await orchestrator.run({
      name: 'mw-workflow',
      cwd: '/tmp',
      nodes: [{ name: 'task', agent, prompt: 'Do it' }],
    });

    expect(result.status).toBe(ExecutionStatus.COMPLETED);
    // LoggingMiddleware emits agent.started and agent.completed
    const types = agentEvents.map((e) => e.type);
    expect(types).toContain('agent.started');
    expect(types).toContain('agent.completed');
  });
});

describe('M2 Integration: Memory across agents', () => {
  it('should share workflow memory between agents', async () => {
    const mm = new DefaultMemoryManager();
    const workflowId = 'wf-shared-test';

    // Agent 1 writes to workflow memory
    const { kv: kv1, workflowKv: wk1 } = mm.createAgentMemory(workflowId, 'agent-1', 'read-write');
    await wk1.set('api-schema', '{ "endpoint": "/users" }');
    await kv1.set('private', 'agent-1-only');

    // Agent 2 reads from workflow memory
    const { kv: kv2, workflowKv: wk2 } = mm.createAgentMemory(workflowId, 'agent-2', 'read-write');
    const schema = await wk2.get('api-schema');
    expect(schema).toBe('{ "endpoint": "/users" }');

    // Agent 2 cannot see agent 1's private data
    const privateData = await kv2.get('private');
    expect(privateData).toBeNull();

    // Cleanup clears both
    await mm.cleanupWorkflow(workflowId);
    expect(await wk1.get('api-schema')).toBeNull();
    expect(await kv1.get('private')).toBeNull();
  });

  it('should support reactive memory subscriptions', async () => {
    const mm = new DefaultMemoryManager();
    const workflowId = 'wf-reactive-test';

    const { workflowKv: wk1 } = mm.createAgentMemory(workflowId, 'agent-1', 'read-write');
    const { workflowKv: wk2 } = mm.createAgentMemory(workflowId, 'agent-2', 'read-write');

    // Agent 2 subscribes to a key
    const changes: string[] = [];
    wk2.subscribe('signal', (value) => {
      if (value) changes.push(value);
    });

    // Agent 1 writes to the key
    await wk1.set('signal', 'ready');
    await wk1.set('signal', 'done');

    expect(changes).toEqual(['ready', 'done']);
  });
});
