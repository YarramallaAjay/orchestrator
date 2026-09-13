import type { Task, EffortEstimate } from '../task/types.js';
import type { AgentConfig, AgentCapability } from '../agent/types.js';

export interface SchedulerAssignment {
  task: Task;
  agent: AgentConfig;
}

export interface SchedulerConfig {
  maxConcurrent: number;
  currentRunning: number;
}

/** Maps effort level to an appropriate model tier. */
const EFFORT_MODEL_MAP: Record<EffortEstimate, string> = {
  trivial: 'claude-haiku-4',
  small: 'claude-haiku-4',
  medium: 'claude-sonnet-4-6',
  large: 'claude-sonnet-4-6',
  xlarge: 'claude-opus-4',
};

/**
 * Matches ready tasks to agent templates based on capabilities and priority.
 * Respects concurrency limits and avoids file conflicts in the same batch.
 */
export class Scheduler {
  /**
   * Given ready tasks and available agent templates, produce assignments.
   * Returns assignments sorted by task priority (lowest number = highest priority).
   * Skips tasks that would conflict with already-scheduled tasks (shared file paths).
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
    const scheduledFileSets: Set<string>[] = [];

    for (const task of sorted) {
      if (assignments.length >= availableSlots) break;

      // Check for file overlaps with already-scheduled tasks
      const taskFiles = this.extractMentionedFiles(task);
      if (this.hasFileConflict(taskFiles, scheduledFileSets)) {
        continue; // Skip — would conflict with an already-scheduled task
      }

      const agent = this.findBestAgent(task, agentTemplates);
      if (agent) {
        assignments.push({ task, agent });
        scheduledFileSets.push(taskFiles);
      }
    }

    return assignments;
  }

  /**
   * Predict file overlaps between a set of tasks.
   * Returns pairs of task IDs that mention the same files.
   */
  predictFileOverlaps(tasks: Task[]): Array<[string, string]> {
    const overlaps: Array<[string, string]> = [];
    const taskFiles = tasks.map((t) => ({
      id: t.id,
      files: this.extractMentionedFiles(t),
    }));

    for (let i = 0; i < taskFiles.length; i++) {
      for (let j = i + 1; j < taskFiles.length; j++) {
        const a = taskFiles[i]!;
        const b = taskFiles[j]!;
        for (const file of a.files) {
          if (b.files.has(file)) {
            overlaps.push([a.id, b.id]);
            break;
          }
        }
      }
    }

    return overlaps;
  }

  /**
   * Find the best matching agent template for a task.
   * Applies cost-aware model selection based on estimated effort.
   */
  private findBestAgent(task: Task, templates: AgentConfig[]): AgentConfig | null {
    let config: AgentConfig;

    if (templates.length === 0) {
      config = {
        id: 'default',
        name: 'Default Agent',
        role: 'developer',
        runtimeType: 'claude-sdk',
        capabilities: [],
        model: 'claude-sonnet-4-6',
        maxTurns: 25,
        permissionMode: 'default',
      };
    } else {
      // Score each template
      const scored = templates.map((template) => ({
        template,
        score: this.scoreMatch(task, template),
      }));
      scored.sort((a, b) => b.score - a.score);
      config = { ...scored[0]!.template };
    }

    // Apply cost-aware model selection if effort is set and model isn't explicitly configured
    if (task.estimatedEffort && !config.model) {
      config.model = EFFORT_MODEL_MAP[task.estimatedEffort];
    } else if (task.estimatedEffort && config.model === 'claude-sonnet-4-6') {
      // Override default sonnet with effort-based model
      config.model = EFFORT_MODEL_MAP[task.estimatedEffort];
    }

    return config;
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

  /**
   * Get files associated with a task.
   * Prefers explicit targetFiles (from planner), falls back to regex extraction from description.
   */
  private extractMentionedFiles(task: Task): Set<string> {
    // Use targetFiles if available (deterministic, planner-specified)
    if (task.targetFiles && task.targetFiles.length > 0) {
      return new Set(task.targetFiles);
    }

    // Fallback: extract file paths from task title and description via regex
    const files = new Set<string>();
    const text = `${task.title} ${task.description}`;

    const patterns = [
      /(?:^|\s|`)([a-zA-Z0-9_./\-]+\.[a-zA-Z]{1,10})(?:\s|$|`|,|;|\))/g,  // file.ext
      /(?:^|\s|`)(src\/[^\s`]+)/g,                                            // src/...
      /(?:^|\s|`)(lib\/[^\s`]+)/g,                                            // lib/...
      /(?:^|\s|`)(tests?\/[^\s`]+)/g,                                         // test(s)/...
      /(?:^|\s|`)(app\/[^\s`]+)/g,                                            // app/...
      /(?:^|\s|`)(pages?\/[^\s`]+)/g,                                         // page(s)/...
      /(?:^|\s|`)(components?\/[^\s`]+)/g,                                    // component(s)/...
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (match[1]) {
          files.add(match[1]);
        }
      }
    }

    return files;
  }

  /**
   * Check if a task's file set overlaps with any already-scheduled task.
   */
  private hasFileConflict(taskFiles: Set<string>, scheduledSets: Set<string>[]): boolean {
    if (taskFiles.size === 0) return false;

    for (const scheduled of scheduledSets) {
      for (const file of taskFiles) {
        if (scheduled.has(file)) return true;
      }
    }

    return false;
  }
}
