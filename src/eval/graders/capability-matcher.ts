import type { Task } from '../../task/types.js';
import type { AgentConfig } from '../../agent/types.js';

export interface CapabilityMatchResult {
  valid: boolean;
  mismatches: Array<{
    taskId: string;
    taskTags: string[];
    agentId: string;
    agentCapabilities: string[];
    reason: string;
  }>;
  matchRate: number;
}

/**
 * Validates that agents were assigned to tasks they're capable of handling.
 * Checks that agent capabilities overlap with task tags.
 */
export function checkCapabilityMatch(
  assignments: Array<{ task: Task; agent: AgentConfig }>,
): CapabilityMatchResult {
  const result: CapabilityMatchResult = {
    valid: true,
    mismatches: [],
    matchRate: 0,
  };

  if (assignments.length === 0) {
    result.matchRate = 1;
    return result;
  }

  let matches = 0;

  for (const { task, agent } of assignments) {
    const agentCapNames = agent.capabilities.map((c) => c.name.toLowerCase());

    // A match is valid if:
    // 1. Agent has no specific capabilities (generic agent, matches everything)
    // 2. At least one task tag matches an agent capability
    // 3. Agent role is relevant to the task tags
    const isGenericAgent = agentCapNames.length === 0;
    const hasTagMatch = task.tags.some((tag) =>
      agentCapNames.includes(tag.toLowerCase()),
    );

    if (isGenericAgent || hasTagMatch) {
      matches++;
    } else {
      result.valid = false;
      result.mismatches.push({
        taskId: task.id,
        taskTags: task.tags,
        agentId: agent.id,
        agentCapabilities: agentCapNames,
        reason: `No capability overlap: task tags [${task.tags.join(', ')}] vs agent capabilities [${agentCapNames.join(', ')}]`,
      });
    }
  }

  result.matchRate = matches / assignments.length;
  return result;
}
