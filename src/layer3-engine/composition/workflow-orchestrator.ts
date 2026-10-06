/**
 * Workflow orchestrator -- the main composition engine.
 *
 * Drives DAG-based workflows by:
 * 1. Building the DAG from workflow definitions
 * 2. Polling for ready nodes via the pluggable scheduler
 * 3. Dispatching nodes to the execution engine
 * 4. Handling retries, cancellations, and completion
 * 5. Publishing lifecycle events
 */

import { nanoid } from 'nanoid';
import { DAGScheduler } from './dag-scheduler.js';
import { NodeStatus, type WorkflowNode, type Scheduler, type SchedulerConstraints } from './scheduler-interface.js';
import type { ExecutionEngine, ExecutionRequest } from '../execution/types.js';
import type { EventBus } from '../../layer2-core/events/types.js';
import { EventTypes } from '../../layer2-core/events/types.js';
import { createEvent } from '../../layer2-core/events/event-bus.js';
import type { MemoryManager } from '../../layer2-core/memory/types.js';
import type { MiddlewareChain } from '../middleware/chain.js';
import type { AgentDefinition, ExecutionResult, ExecutionMetrics } from '../../platform/types.js';
import { ExecutionStatus } from '../../platform/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowDefinition {
  id?: string;
  name: string;
  nodes: WorkflowNodeInput[];
  constraints?: Partial<SchedulerConstraints>;
  cwd: string;
  projectId?: string;
  scheduler?: Scheduler;
}

export interface WorkflowNodeInput {
  id?: string;
  name: string;
  agent: AgentDefinition;
  prompt: string;
  dependsOn?: string[];
  priority?: number;
}

export interface WorkflowResult {
  id: string;
  status: ExecutionStatus;
  nodeResults: Map<string, ExecutionResult>;
  metrics: ExecutionMetrics;
}

// ─── Workflow Orchestrator ──────────────────────────────────────────────────

export class WorkflowOrchestrator {
  constructor(
    private engine: ExecutionEngine,
    private eventBus: EventBus,
    private memoryManager?: MemoryManager,
    private middlewareChain?: MiddlewareChain,
  ) {}

  async run(definition: WorkflowDefinition): Promise<WorkflowResult> {
    const workflowId = definition.id ?? `workflow_${nanoid(8)}`;
    const dag = new DAGScheduler(definition.scheduler);
    const nodeResults = new Map<string, ExecutionResult>();

    // Build the DAG
    for (const input of definition.nodes) {
      const node: WorkflowNode = {
        id: input.id ?? `node_${nanoid(8)}`,
        name: input.name,
        agent: input.agent,
        status: NodeStatus.PENDING,
        dependsOn: input.dependsOn ?? [],
        prompt: input.prompt,
        priority: input.priority ?? 10,
        attempt: 0,
      };
      dag.addNode(node);
    }

    // Validate: detect cycles
    dag.topologicalSort();

    const constraints: SchedulerConstraints = {
      maxConcurrent: definition.constraints?.maxConcurrent ?? 3,
      maxBudgetUsd: definition.constraints?.maxBudgetUsd,
      currentCostUsd: 0,
    };

    // Emit workflow started
    await this.eventBus.publish(
      createEvent(EventTypes.WORKFLOW_STARTED, 'orchestrator', {
        workflowId,
        workflowName: definition.name,
        nodeCount: definition.nodes.length,
        criticalPathLength: dag.criticalPath().length,
      }, {
        projectId: definition.projectId,
        workflowId,
      }),
    );

    const aggregatedMetrics: ExecutionMetrics = {
      durationMs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      turns: 0,
    };

    const startTime = Date.now();

    // Main scheduling loop
    while (!dag.isComplete()) {
      const batch = dag.getNextBatch(constraints);

      if (batch.length === 0) {
        // Nothing to dispatch -- check if we're stuck
        const hasRunning = dag.getAllNodes().some(
          (n) => n.status === NodeStatus.RUNNING || n.status === NodeStatus.RETRYING,
        );

        if (!hasRunning) {
          // Deadlocked or all remaining nodes have failed deps
          break;
        }

        // Wait for a running node to complete
        await this.waitForCompletion();
        continue;
      }

      // Dispatch batch in parallel
      const promises = batch.map((node) =>
        this.executeNode(node, dag, workflowId, definition, constraints, nodeResults),
      );

      await Promise.all(promises);
    }

    aggregatedMetrics.durationMs = Date.now() - startTime;

    // Aggregate metrics from all node results
    for (const result of nodeResults.values()) {
      if (result.metrics) {
        aggregatedMetrics.costUsd = (aggregatedMetrics.costUsd ?? 0) + (result.metrics.costUsd ?? 0);
        aggregatedMetrics.inputTokens = (aggregatedMetrics.inputTokens ?? 0) + (result.metrics.inputTokens ?? 0);
        aggregatedMetrics.outputTokens = (aggregatedMetrics.outputTokens ?? 0) + (result.metrics.outputTokens ?? 0);
        aggregatedMetrics.toolCalls = (aggregatedMetrics.toolCalls ?? 0) + (result.metrics.toolCalls ?? 0);
        aggregatedMetrics.turns = (aggregatedMetrics.turns ?? 0) + (result.metrics.turns ?? 0);
      }
    }

    const overallStatus = dag.hasFailed()
      ? ExecutionStatus.FAILED
      : ExecutionStatus.COMPLETED;

    // Emit workflow completed/failed
    const eventType = overallStatus === ExecutionStatus.COMPLETED
      ? EventTypes.WORKFLOW_COMPLETED
      : EventTypes.WORKFLOW_FAILED;

    await this.eventBus.publish(
      createEvent(eventType, 'orchestrator', {
        workflowId,
        status: overallStatus,
        metrics: aggregatedMetrics,
        completedNodes: [...nodeResults.entries()]
          .filter(([, r]) => r.status === ExecutionStatus.COMPLETED)
          .map(([id]) => id).length,
        failedNodes: [...nodeResults.entries()]
          .filter(([, r]) => r.status === ExecutionStatus.FAILED)
          .map(([id]) => id).length,
      }, {
        projectId: definition.projectId,
        workflowId,
      }),
    );

    // Clean up workflow memory
    if (this.memoryManager) {
      await this.memoryManager.cleanupWorkflow(workflowId);
    }

    return {
      id: workflowId,
      status: overallStatus,
      nodeResults,
      metrics: aggregatedMetrics,
    };
  }

  private async executeNode(
    node: WorkflowNode,
    dag: DAGScheduler,
    workflowId: string,
    definition: WorkflowDefinition,
    constraints: SchedulerConstraints,
    nodeResults: Map<string, ExecutionResult>,
  ): Promise<void> {
    node.status = NodeStatus.RUNNING;
    node.attempt += 1;
    dag.updateNode(node);

    // Build context from dependency outputs
    const depContext = this.buildDependencyContext(node, dag, nodeResults);

    const executionId = `${workflowId}_${node.id}_attempt${node.attempt}`;

    const request: ExecutionRequest = {
      id: executionId,
      agent: node.agent,
      prompt: node.prompt,
      cwd: definition.cwd,
      context: depContext || undefined,
      attempt: node.attempt,
      workflowId,
      projectId: definition.projectId,
    };

    let result: ExecutionResult;

    if (this.middlewareChain) {
      result = await this.middlewareChain.execute(
        {
          executionId,
          agent: node.agent,
          input: node.prompt,
          workflowId,
          projectId: definition.projectId,
          metadata: { nodeId: node.id, context: depContext },
        },
        () => this.engine.execute(request),
      );
    } else {
      result = await this.engine.execute(request);
    }

    // Update node state
    if (result.status === ExecutionStatus.COMPLETED) {
      node.status = NodeStatus.COMPLETED;
      node.output = result.output;
      node.artifacts = result.artifacts;
    } else {
      // Check if we should retry
      const maxRetries = node.agent.preferences.maxRetries;
      if (node.attempt < maxRetries + 1) {
        node.status = NodeStatus.RETRYING;
        node.error = result.error;
        dag.updateNode(node);

        // Re-queue by setting to PENDING so scheduler picks it up
        node.status = NodeStatus.PENDING;
        dag.updateNode(node);
        return;
      }

      node.status = NodeStatus.FAILED;
      node.error = result.error;

      // Cascade-cancel dependents
      dag.cascadeCancel(node.id);
      // The node itself was already set to CANCELLED by cascadeCancel, override to FAILED
      node.status = NodeStatus.FAILED;
    }

    dag.updateNode(node);
    nodeResults.set(node.id, result);

    // Update cost tracking
    if (result.metrics?.costUsd) {
      constraints.currentCostUsd = (constraints.currentCostUsd ?? 0) + result.metrics.costUsd;
    }
  }

  private buildDependencyContext(
    node: WorkflowNode,
    dag: DAGScheduler,
    nodeResults: Map<string, ExecutionResult>,
  ): string {
    const parts: string[] = [];

    for (const depId of node.dependsOn) {
      const depNode = dag.getNode(depId);
      const depResult = nodeResults.get(depId);

      if (depNode && depResult?.output) {
        parts.push(`--- Output from "${depNode.name}" ---\n${depResult.output}`);
      }
    }

    return parts.join('\n\n');
  }

  private waitForCompletion(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 100));
  }
}
