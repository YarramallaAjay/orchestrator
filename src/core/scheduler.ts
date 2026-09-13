import type { Task } from '../task/types.js';
import type { AgentConfig, AgentCapability } from '../agent/types.js';

export interface SchedulerAssignment {
  task: Task;
  agent: AgentConfig;
}

export interface SchedulerConfig {
  maxConcurrent: number;
  currentRunning: number;
}

/**
 * Matches ready tasks to agent templates based on capabilities and priority.
 * Respects concurrency limits.
 */
export class Scheduler {
  /**
   * Given ready tasks and available agent templates, produce assignments.
   * Returns assignments sorted by task priority (lowest number = highest priority).
   */
  schedule(
    readyTasks: Task[],
    agentTemplates: AgentConfig[],
    config: SchedulerConfig,
  ): SchedulerAssignment[] {
    const availableSlots = config.maxConcurrent - config.currentRunning;
    if (availableSlots <= 0) return [];

    // Sort by priority (lower number = higher priority)
    const sorted = [...readyTasks].sort((a, b) => a.priority - b.priority);

    const assignments: SchedulerAssignment[] = [];

    for (const task of sorted) {
      if (assignments.length >= availableSlots) break;

      const agent = this.findBestAgent(task, agentTemplates);
      if (agent) {
        assignments.push({ task, agent });
      }
    }

    return assignments;
  }

  /**
   * Find the best matching agent template for a task.
   * Matches based on tags -> capabilities overlap.
   */
  private findBestAgent(task: Task, templates: AgentConfig[]): AgentConfig | null {
    if (templates.length === 0) {
      // Return a default agent config if no templates are defined
      return {
        id: 'default',
        name: 'Default Agent',
        role: 'developer',
        runtimeType: 'claude-cli',
        capabilities: [],
        model: 'claude-sonnet-4-6',
        maxTurns: 25,
        permissionMode: 'default',
      };
    }

    // Score each template
    const scored = templates.map((template) => ({
      template,
      score: this.scoreMatch(task, template),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored[0]?.template ?? null;
  }

  /**
   * Score how well an agent template matches a task.
   * Higher score = better match.
   */
  private scoreMatch(task: Task, template: AgentConfig): number {
    let score = 0;

    // Check tag-to-capability overlap
    for (const tag of task.tags) {
      const matchingCap = template.capabilities.find(
        (cap) => cap.name.toLowerCase() === tag.toLowerCase(),
      );
      if (matchingCap) {
        score += this.levelScore(matchingCap);
      }
    }

    // Check role match with task classification
    const roleMatches: Record<string, string[]> = {
      'backend-developer': ['backend', 'api', 'server', 'database'],
      'frontend-developer': ['frontend', 'ui', 'client', 'react'],
      'test-engineer': ['testing', 'test', 'qa'],
      'devops-engineer': ['deployment', 'ci', 'infrastructure'],
      'security-engineer': ['security', 'auth', 'authentication'],
      'documentation': ['docs', 'documentation'],
    };

    const roleKeywords = roleMatches[template.role] ?? [];
    for (const keyword of roleKeywords) {
      if (task.tags.includes(keyword)) score += 2;
      if (task.title.toLowerCase().includes(keyword)) score += 1;
      if (task.description.toLowerCase().includes(keyword)) score += 1;
    }

    return score;
  }

  private levelScore(cap: AgentCapability): number {
    switch (cap.level) {
      case 'expert': return 3;
      case 'proficient': return 2;
      case 'basic': return 1;
      default: return 0;
    }
  }
}
