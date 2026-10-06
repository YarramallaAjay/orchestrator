/**
 * Execution engine -- dispatches agent tasks to runtime adapters.
 *
 * M1: Single agent execution (no DAG, no pipeline).
 * M2: Will add retry, DAG scheduling, middleware chain.
 */

import { nanoid } from 'nanoid';
import type { AdapterRegistry } from '../../layer1-adapters/adapter-registry.js';
import type { RuntimeAdapter, RuntimeEvent, AdapterConfig, RuntimeResult } from '../../layer1-adapters/types.js';
import type { EventBus, PlatformEvent } from '../../layer2-core/events/types.js';
import { EventTypes } from '../../layer2-core/events/types.js';
import { createEvent } from '../../layer2-core/events/event-bus.js';
import { ExecutionStatus } from '../../platform/types.js';
import type { AgentDefinition, ExecutionResult, ExecutionMetrics } from '../../platform/types.js';
import type { ExecutionRequest, ExecutionEngine as IExecutionEngine } from './types.js';

export class ExecutionEngine implements IExecutionEngine {
  private running = new Map<string, { adapter: RuntimeAdapter; request: ExecutionRequest }>();

  constructor(
    private adapterRegistry: AdapterRegistry,
    private eventBus: EventBus,
  ) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    let lastResult: ExecutionResult | null = null;

    for await (const event of this.executeStreaming(request)) {
      if (event.type === 'done') {
        lastResult = this.toExecutionResult(event.result);
      }
    }

    return lastResult ?? {
      status: ExecutionStatus.FAILED,
      error: 'Execution completed without a result event',
    };
  }

  async *executeStreaming(
    request: ExecutionRequest,
  ): AsyncGenerator<RuntimeEvent, ExecutionResult, undefined> {
    const runtimeType = request.agent.runtime ?? 'claude-code';

    // Create and initialize the adapter
    const adapterConfig: AdapterConfig = {
      id: `adapter_${nanoid(8)}`,
      type: runtimeType,
      cwd: request.cwd,
      model: request.agent.adapterConfig?.model as string | undefined,
      maxTurns: request.agent.adapterConfig?.maxTurns as number | undefined,
      maxBudgetUsd: request.agent.adapterConfig?.maxBudgetUsd as number | undefined,
      env: request.agent.adapterConfig?.env as Record<string, string> | undefined,
      allowedTools: request.agent.adapterConfig?.allowedTools as string[] | undefined,
      permissionMode: request.agent.adapterConfig?.permissionMode as any,
      systemPrompt: request.agent.instructions,
      extra: request.agent.adapterConfig,
    };

    const adapter = this.adapterRegistry.create(runtimeType, adapterConfig);
    await adapter.initialize(adapterConfig);

    this.running.set(request.id, { adapter, request });

    // Emit execution started event
    await this.eventBus.publish(
      createEvent(EventTypes.EXECUTION_STARTED, 'engine', {
        executionId: request.id,
        agentId: request.agent.id,
        agentName: request.agent.name,
        runtime: runtimeType,
        attempt: request.attempt,
      }, {
        projectId: request.projectId,
        workflowId: request.workflowId,
        agentId: request.agent.id,
      }),
    );

    let finalResult: RuntimeResult | null = null;

    try {
      const generator = adapter.execute({
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        context: request.context,
        retryFeedback: request.retryFeedback,
      });

      for await (const event of generator) {
        // Forward runtime events to the event bus
        await this.forwardEvent(request, event);

        if (event.type === 'done') {
          finalResult = event.result;
        }

        yield event;
      }
    } catch (err: any) {
      const errorEvent: RuntimeEvent = {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
        recoverable: false,
        timestamp: new Date().toISOString(),
      };
      yield errorEvent;

      finalResult = {
        success: false,
        output: err.message ?? String(err),
        metrics: {
          durationMs: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
          turns: 0,
        },
      };
    } finally {
      this.running.delete(request.id);
    }

    const result = this.toExecutionResult(finalResult!);

    // Emit completion event
    const eventType = result.status === 'completed'
      ? EventTypes.EXECUTION_COMPLETED
      : EventTypes.EXECUTION_FAILED;

    await this.eventBus.publish(
      createEvent(eventType, 'engine', {
        executionId: request.id,
        agentId: request.agent.id,
        status: result.status,
        metrics: result.metrics,
        error: result.error,
      }, {
        projectId: request.projectId,
        workflowId: request.workflowId,
        agentId: request.agent.id,
      }),
    );

    return result;
  }

  async cancel(executionId: string): Promise<void> {
    const entry = this.running.get(executionId);
    if (entry) {
      await entry.adapter.cancel();
      this.running.delete(executionId);
    }
  }

  getStatus(executionId: string): ExecutionRequest | null {
    const entry = this.running.get(executionId);
    return entry?.request ?? null;
  }

  private toExecutionResult(result: RuntimeResult): ExecutionResult {
    return {
      status: result.success ? ExecutionStatus.COMPLETED : ExecutionStatus.FAILED,
      output: result.output,
      artifacts: result.artifacts,
      error: result.success ? undefined : result.output,
      metrics: {
        durationMs: result.metrics.durationMs,
        costUsd: result.metrics.costUsd,
        inputTokens: result.metrics.inputTokens,
        outputTokens: result.metrics.outputTokens,
        toolCalls: result.metrics.toolCalls,
        turns: result.metrics.turns,
      },
    };
  }

  private async forwardEvent(request: ExecutionRequest, event: RuntimeEvent): Promise<void> {
    if (event.type === 'progress') {
      await this.eventBus.publish(
        createEvent(EventTypes.AGENT_PROGRESS, 'engine', {
          executionId: request.id,
          message: event.message,
          percent: event.percent,
        }, {
          agentId: request.agent.id,
          projectId: request.projectId,
          workflowId: request.workflowId,
        }),
      );
    }
  }
}
