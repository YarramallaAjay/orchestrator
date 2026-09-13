import type { Task } from '../task/types.js';
import type { AgentConfig } from './types.js';
import type { ContextStore } from '../context/context-store.js';

/**
 * Builds isolated, task-specific context for an agent.
 * Ensures each agent receives only the context relevant to its work.
 */
export class AgentContextBuilder {
  constructor(private contextStore: ContextStore) {}

  /**
   * Build a complete prompt context for an agent executing a task.
   */
  async build(
    projectId: string,
    task: Task,
    agentConfig: AgentConfig,
    additionalInfo?: {
      worktreePath?: string;
      retryFeedback?: string;
    },
  ): Promise<string> {
    const sections: string[] = [];

    // Role and system context
    sections.push(`# Agent Role: ${agentConfig.name}`);
    sections.push(`You are acting as a ${agentConfig.role}.`);
    sections.push('');

    // Task details
    sections.push(`# Task: ${task.title}`);
    sections.push(task.description);
    sections.push('');

    // Acceptance criteria
    if (task.acceptanceCriteria.length > 0) {
      sections.push('## Acceptance Criteria');
      for (const criterion of task.acceptanceCriteria) {
        sections.push(`- ${criterion}`);
      }
      sections.push('');
    }

    // Input context
    if (Object.keys(task.inputContext).length > 0) {
      const ctx = { ...task.inputContext };
      // Remove internal retry feedback from display
      delete ctx._retryFeedback;

      if (Object.keys(ctx).length > 0) {
        sections.push('## Task Input Context');
        sections.push('```json');
        sections.push(JSON.stringify(ctx, null, 2));
        sections.push('```');
        sections.push('');
      }
    }

    // Shared project context
    const sharedContext = await this.contextStore.buildAgentContext(projectId, task);
    if (sharedContext) {
      sections.push(sharedContext);
      sections.push('');
    }

    // Worktree info
    if (additionalInfo?.worktreePath) {
      sections.push('## Working Directory');
      sections.push(`You are working in an isolated git worktree at: ${additionalInfo.worktreePath}`);
      sections.push('Commit your changes to this branch when done.');
      sections.push('');
    }

    // Retry feedback
    const retryFeedback = additionalInfo?.retryFeedback
      ?? (task.inputContext._retryFeedback as string | undefined);
    if (retryFeedback) {
      sections.push('## Previous Attempt Feedback');
      sections.push(retryFeedback);
      sections.push('');
    }

    // Validation instructions
    if (task.validationScript) {
      sections.push('## Validation');
      sections.push(`After completing the work, run this command to validate: \`${task.validationScript}\``);
      sections.push('');
    }

    return sections.join('\n');
  }
}
