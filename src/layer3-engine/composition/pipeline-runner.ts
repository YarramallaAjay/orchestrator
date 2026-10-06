/**
 * Pipeline runner -- sequential step execution.
 *
 * Executes a linear sequence of steps, passing output from one step
 * as context into the next. Supports retry on individual steps.
 */

import { nanoid } from 'nanoid';
import type { ExecutionEngine } from '../execution/types.js';
import type { AgentDefinition, ExecutionResult, ExecutionMetrics } from '../../platform/types.js';
import { ExecutionStatus } from '../../platform/types.js';
import type { EventBus } from '../../layer2-core/events/types.js';
import { EventTypes } from '../../layer2-core/events/types.js';
import { createEvent } from '../../layer2-core/events/event-bus.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PipelineStep {
  /** Unique step name. */
  name: string;
  /** The agent to run this step. */
  agent: AgentDefinition;
  /** The prompt for this step. Use {{previous}} for previous step output. */
  prompt: string;
  /** Max retries for this step. Defaults to agent's maxRetries. */
  maxRetries?: number;
}

export interface PipelineConfig {
  /** Pipeline ID. */
  id?: string;
  /** Pipeline name. */
  name: string;
  /** Ordered list of steps. */
  steps: PipelineStep[];
  /** Working directory for execution. */
  cwd: string;
  /** Project ID. */
  projectId?: string;
  /** Workflow ID. */
  workflowId?: string;
}

export interface PipelineResult {
  status: ExecutionStatus;
  /** Output from the final step. */
  output?: string;
  /** Per-step results. */
  stepResults: StepResult[];
  /** Aggregated metrics. */
  metrics: ExecutionMetrics;
}

export interface StepResult {
  stepName: string;
  result: ExecutionResult;
  attempt: number;
}

// ─── Pipeline Runner ────────────────────────────────────────────────────────

export class PipelineRunner {
  constructor(
    private engine: ExecutionEngine,
    private eventBus: EventBus,
  ) {}

  async run(config: PipelineConfig): Promise<PipelineResult> {
    const pipelineId = config.id ?? `pipeline_${nanoid(8)}`;
    const stepResults: StepResult[] = [];
    let previousOutput: string | undefined;
    const aggregatedMetrics: ExecutionMetrics = {
      durationMs: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      turns: 0,
    };

    await this.eventBus.publish(
      createEvent(EventTypes.WORKFLOW_STARTED, 'pipeline', {
        pipelineId,
        pipelineName: config.name,
        stepCount: config.steps.length,
      }, {
        projectId: config.projectId,
        workflowId: config.workflowId,
      }),
    );

    for (let i = 0; i < config.steps.length; i++) {
      const step = config.steps[i]!;
      const maxRetries = step.maxRetries ?? step.agent.preferences.maxRetries;

      let lastResult: ExecutionResult | null = null;
      let succeeded = false;

      for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        // Interpolate {{previous}} placeholder in prompt
        let prompt = step.prompt;
        if (previousOutput) {
          prompt = prompt.replace(/\{\{previous\}\}/g, previousOutput);
        }

        const executionId = `${pipelineId}_step${i}_attempt${attempt}`;

        lastResult = await this.engine.execute({
          id: executionId,
          agent: step.agent,
          prompt,
          cwd: config.cwd,
          context: previousOutput,
          attempt,
          retryFeedback: attempt > 1 && lastResult?.error
            ? `Previous attempt failed: ${lastResult.error}`
            : undefined,
          workflowId: config.workflowId,
          projectId: config.projectId,
        });

        if (lastResult.status === ExecutionStatus.COMPLETED) {
          succeeded = true;
          stepResults.push({ stepName: step.name, result: lastResult, attempt });

          await this.eventBus.publish(
            createEvent(EventTypes.WORKFLOW_STEP_COMPLETED, 'pipeline', {
              pipelineId,
              stepName: step.name,
              stepIndex: i,
              attempt,
            }, {
              projectId: config.projectId,
              workflowId: config.workflowId,
            }),
          );

          break;
        }

        // If not the last retry attempt, emit retrying event
        if (attempt < maxRetries + 1) {
          await this.eventBus.publish(
            createEvent(EventTypes.EXECUTION_RETRYING, 'pipeline', {
              pipelineId,
              stepName: step.name,
              attempt,
              error: lastResult.error,
            }, {
              projectId: config.projectId,
              workflowId: config.workflowId,
            }),
          );
        }
      }

      if (!succeeded) {
        // Step failed after all retries
        stepResults.push({
          stepName: step.name,
          result: lastResult!,
          attempt: maxRetries + 1,
        });

        this.accumulateMetrics(aggregatedMetrics, stepResults);

        await this.eventBus.publish(
          createEvent(EventTypes.WORKFLOW_FAILED, 'pipeline', {
            pipelineId,
            failedStep: step.name,
            error: lastResult?.error,
          }, {
            projectId: config.projectId,
            workflowId: config.workflowId,
          }),
        );

        return {
          status: ExecutionStatus.FAILED,
          output: lastResult?.error,
          stepResults,
          metrics: aggregatedMetrics,
        };
      }

      // Pass output to next step
      previousOutput = lastResult!.output;
    }

    this.accumulateMetrics(aggregatedMetrics, stepResults);

    await this.eventBus.publish(
      createEvent(EventTypes.WORKFLOW_COMPLETED, 'pipeline', {
        pipelineId,
        stepCount: config.steps.length,
        metrics: aggregatedMetrics,
      }, {
        projectId: config.projectId,
        workflowId: config.workflowId,
      }),
    );

    return {
      status: ExecutionStatus.COMPLETED,
      output: previousOutput,
      stepResults,
      metrics: aggregatedMetrics,
    };
  }

  private accumulateMetrics(
    target: ExecutionMetrics,
    stepResults: StepResult[],
  ): void {
    target.durationMs = 0;
    target.costUsd = 0;
    target.inputTokens = 0;
    target.outputTokens = 0;
    target.toolCalls = 0;
    target.turns = 0;

    for (const sr of stepResults) {
      const m = sr.result.metrics;
      if (m) {
        target.durationMs += m.durationMs;
        target.costUsd = (target.costUsd ?? 0) + (m.costUsd ?? 0);
        target.inputTokens = (target.inputTokens ?? 0) + (m.inputTokens ?? 0);
        target.outputTokens = (target.outputTokens ?? 0) + (m.outputTokens ?? 0);
        target.toolCalls = (target.toolCalls ?? 0) + (m.toolCalls ?? 0);
        target.turns = (target.turns ?? 0) + (m.turns ?? 0);
      }
    }
  }
}
