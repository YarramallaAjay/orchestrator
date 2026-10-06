import { describe, it, expect } from 'vitest';
import { DAGScheduler, DefaultPriorityScheduler } from '../../../src/layer3-engine/composition/dag-scheduler.js';
import { NodeStatus, type WorkflowNode, type Scheduler, type SchedulerConstraints } from '../../../src/layer3-engine/composition/scheduler-interface.js';
import { Agent } from '../../../src/layer4-surface/sdk/agent-builder.js';

function makeNode(overrides: Partial<WorkflowNode> & { id: string; name: string }): WorkflowNode {
  const agent = Agent.create(overrides.name).build();
  return {
    agent,
    status: NodeStatus.PENDING,
    dependsOn: [],
    prompt: `Do ${overrides.name}`,
    priority: 10,
    attempt: 0,
    ...overrides,
  };
}

describe('DAGScheduler', () => {
  it('should add and retrieve nodes', () => {
    const dag = new DAGScheduler();
    const node = makeNode({ id: 'a', name: 'alpha' });
    dag.addNode(node);

    expect(dag.getNode('a')).toBe(node);
    expect(dag.size()).toBe(1);
    expect(dag.getAllNodes()).toHaveLength(1);
  });

  it('should detect ready nodes (no dependencies)', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta' }));

    const ready = dag.getReadyNodes();
    expect(ready).toHaveLength(2);
  });

  it('should block nodes with unmet dependencies', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));

    const ready = dag.getReadyNodes();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe('a');
  });

  it('should unblock nodes when dependencies complete', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));

    // Complete node a
    const a = dag.getNode('a')!;
    a.status = NodeStatus.COMPLETED;
    dag.updateNode(a);

    const ready = dag.getReadyNodes();
    expect(ready).toHaveLength(1);
    expect(ready[0]!.id).toBe('b');
  });

  it('should sort ready nodes by priority', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'low-pri', priority: 20 }));
    dag.addNode(makeNode({ id: 'b', name: 'high-pri', priority: 1 }));
    dag.addNode(makeNode({ id: 'c', name: 'mid-pri', priority: 10 }));

    const ready = dag.getReadyNodes();
    expect(ready.map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  it('should detect cycles', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha', dependsOn: ['b'] }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));

    const cycle = dag.detectCycle();
    expect(cycle).not.toBeNull();
  });

  it('should throw on topological sort with cycle', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha', dependsOn: ['b'] }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));

    expect(() => dag.topologicalSort()).toThrow('cycle');
  });

  it('should topological sort acyclic graphs', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));
    dag.addNode(makeNode({ id: 'c', name: 'gamma', dependsOn: ['a', 'b'] }));

    const sorted = dag.topologicalSort();
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('c'));
  });

  it('should compute critical path', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));
    dag.addNode(makeNode({ id: 'c', name: 'gamma', dependsOn: ['b'] }));
    dag.addNode(makeNode({ id: 'd', name: 'delta' })); // independent

    const cp = dag.criticalPath();
    expect(cp.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('should get ancestors', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));
    dag.addNode(makeNode({ id: 'c', name: 'gamma', dependsOn: ['b'] }));

    const ancestors = dag.getAncestors('c');
    expect(ancestors).toEqual(new Set(['a', 'b']));
  });

  it('should get descendants', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));
    dag.addNode(makeNode({ id: 'c', name: 'gamma', dependsOn: ['a'] }));

    const descendants = dag.getDescendants('a');
    expect(descendants).toEqual(new Set(['b', 'c']));
  });

  it('should cascade cancel', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', dependsOn: ['a'] }));
    dag.addNode(makeNode({ id: 'c', name: 'gamma', dependsOn: ['b'] }));

    const cancelled = dag.cascadeCancel('a');
    expect(cancelled).toEqual(['a', 'b', 'c']);
    expect(dag.getNode('a')!.status).toBe(NodeStatus.CANCELLED);
    expect(dag.getNode('c')!.status).toBe(NodeStatus.CANCELLED);
  });

  it('should report isComplete when all nodes are terminal', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha', status: NodeStatus.COMPLETED }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', status: NodeStatus.FAILED }));

    expect(dag.isComplete()).toBe(true);
  });

  it('should report hasFailed', () => {
    const dag = new DAGScheduler();
    dag.addNode(makeNode({ id: 'a', name: 'alpha', status: NodeStatus.COMPLETED }));
    dag.addNode(makeNode({ id: 'b', name: 'beta', status: NodeStatus.FAILED }));

    expect(dag.hasFailed()).toBe(true);
  });
});

describe('DefaultPriorityScheduler', () => {
  const scheduler = new DefaultPriorityScheduler();

  it('should limit by maxConcurrent', () => {
    const nodes = [
      makeNode({ id: 'a', name: 'alpha' }),
      makeNode({ id: 'b', name: 'beta' }),
      makeNode({ id: 'c', name: 'gamma' }),
    ];

    const batch = scheduler.getNextBatch(nodes, 0, { maxConcurrent: 2 });
    expect(batch).toHaveLength(2);
  });

  it('should account for already-running nodes', () => {
    const nodes = [
      makeNode({ id: 'a', name: 'alpha' }),
      makeNode({ id: 'b', name: 'beta' }),
    ];

    const batch = scheduler.getNextBatch(nodes, 2, { maxConcurrent: 3 });
    expect(batch).toHaveLength(1);
  });

  it('should return empty when at capacity', () => {
    const nodes = [makeNode({ id: 'a', name: 'alpha' })];
    const batch = scheduler.getNextBatch(nodes, 3, { maxConcurrent: 3 });
    expect(batch).toHaveLength(0);
  });

  it('should stop scheduling when budget exceeded', () => {
    const nodes = [makeNode({ id: 'a', name: 'alpha' })];
    const batch = scheduler.getNextBatch(nodes, 0, {
      maxConcurrent: 3,
      maxBudgetUsd: 10,
      currentCostUsd: 10,
    });
    expect(batch).toHaveLength(0);
  });
});

describe('DAGScheduler with custom scheduler', () => {
  it('should use pluggable scheduler for batch selection', () => {
    // Custom scheduler that only picks the first node
    const customScheduler: Scheduler = {
      getNextBatch(ready) {
        return ready.slice(0, 1);
      },
    };

    const dag = new DAGScheduler(customScheduler);
    dag.addNode(makeNode({ id: 'a', name: 'alpha' }));
    dag.addNode(makeNode({ id: 'b', name: 'beta' }));
    dag.addNode(makeNode({ id: 'c', name: 'gamma' }));

    const batch = dag.getNextBatch({ maxConcurrent: 10 });
    expect(batch).toHaveLength(1);
  });
});
