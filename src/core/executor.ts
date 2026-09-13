import type { AgentConfig } from '../agent/types.js';
import type { AgentRuntime, AgentRunResult, AgentMessage } from '../agent/runtimes/runtime.js';
import type { EventBus } from '../events/event-bus.js';
import type { Task } from '../task/types.js';
import { generateId } from '../util/id.js';
import { logger } from '../util/logger.js';

export interface ExecutionContext {
  cwd: string;
  additionalContext?: string;
  mcpServers?: Record<string, unknown>;
}

/**
 * Executes a single task on an agent runtime.
 * Builds the prompt, runs the agent, and streams messages to the event bus.
 */
export class Executor {
  constructor(
    private runtimes: Map<string, AgentRuntime>,
    private eventBus: EventBus,
  ) {}

  async execute(
    task: Task,
    agentConfig: AgentConfig,
    context: ExecutionContext,
  ): Promise<AgentRunResult> {
    const runtime = this.runtimes.get(agentConfig.runtimeType);
    if (!runtime) {
      throw new Error(`No runtime registered for type: ${agentConfig.runtimeType}`);
    }

    const available = await runtime.isAvailable();
    if (!available) {
      throw new Error(`Runtime '${agentConfig.runtimeType}' is not available`);
    }

    const prompt = this.buildPrompt(task, context);
    const abortController = new AbortController();

    logger.info({ taskId: task.id, agent: agentConfig.id, runtime: agentConfig.runtimeType },
      'Executing task');

    const generator = runtime.run({
      prompt,
      systemPrompt: agentConfig.systemPrompt,
      config: agentConfig,
      cwd: context.cwd,
      signal: abortController.signal,
      mcpServers: context.mcpServers,
    });

    let result: AgentRunResult;
    try {
      // Stream messages to the event bus
      while (true) {
        const { value, done } = await generator.next();
        if (done) {
          result = value;
          break;
        }
        // value is an AgentMessage
        const message = value as AgentMessage;
        await this.eventBus.publish({
          id: generateId('evt'),
          type: 'agent.message',
          source: `agent:${agentConfig.id}`,
          timestamp: new Date().toISOString(),
          projectId: task.projectId,
          payload: {
            agentId: agentConfig.id,
            taskId: task.id,
            role: message.role,
            content: message.content,
            toolUse: message.toolUse,
            toolResult: message.toolResult,
          },
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ taskId: task.id, error: errorMsg }, 'Task execution failed');
      result = {
        success: false,
        messages: [],
        outputArtifacts: {},
        totalCostUsd: 0,
        turnsUsed: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        sessionId: null,
        error: errorMsg,
      };
    }

    logger.info({
      taskId: task.id,
      success: result.success,
      cost: result.totalCostUsd,
      turns: result.turnsUsed,
    }, 'Task execution completed');

    return result;
  }

  private buildPrompt(task: Task, context: ExecutionContext): string {
    const parts: string[] = [];

    parts.push(`# Task: ${task.title}\n`);
    parts.push(task.description);

    if (task.acceptanceCriteria.length > 0) {
      parts.push('\n## Acceptance Criteria');
      for (const criterion of task.acceptanceCriteria) {
        parts.push(`- ${criterion}`);
      }
    }

    if (Object.keys(task.inputContext).length > 0) {
      parts.push('\n## Input Context');
      parts.push('```json');
      parts.push(JSON.stringify(task.inputContext, null, 2));
      parts.push('```');
    }

    if (context.additionalContext) {
      parts.push('\n## Project Context');
      parts.push(context.additionalContext);
    }

    if (task.validationScript) {
      parts.push(`\n## Validation`);
      parts.push(`After completing the work, run this validation command: \`${task.validationScript}\``);
    }

    return parts.join('\n');
  }
}
