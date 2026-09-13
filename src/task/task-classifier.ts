import { TaskClassification, type Task, type CreateTaskInput } from './types.js';

const MODULE_KEYWORDS = ['module', 'component', 'service', 'feature', 'page', 'route'];
const CROSS_MODULE_KEYWORDS = ['integration', 'cross-module', 'end-to-end', 'full-stack', 'migrate'];
const HUMAN_KEYWORDS = ['deploy', 'production', 'security review', 'approve', 'sign-off', 'architecture decision'];
const AUTONOMOUS_KEYWORDS = ['lint', 'format', 'typecheck', 'scaffold'];
const AGENT_TAGS = ['frontend', 'backend', 'database', 'security', 'documentation', 'devops'];

/**
 * Auto-classifies tasks based on their title, description, and tags.
 */
export class TaskClassifier {
  /**
   * Classify a task input before creation.
   */
  classify(input: CreateTaskInput): TaskClassification {
    const text = `${input.title} ${input.description}`.toLowerCase();
    const tags = (input.tags ?? []).map((t) => t.toLowerCase());

    // Check HUMAN_IN_THE_LOOP first (highest specificity)
    if (this.matchesAny(text, tags, HUMAN_KEYWORDS)) {
      return TaskClassification.HUMAN_IN_THE_LOOP;
    }

    // Check CROSS_MODULE
    if (this.matchesAny(text, tags, CROSS_MODULE_KEYWORDS)) {
      return TaskClassification.CROSS_MODULE;
    }

    // Check AGENT (specific skill tags)
    if (tags.some((t) => AGENT_TAGS.includes(t))) {
      return TaskClassification.AGENT;
    }

    // Check AUTONOMOUS (simple automated tasks)
    if (this.matchesAny(text, tags, AUTONOMOUS_KEYWORDS)) {
      return TaskClassification.AUTONOMOUS;
    }

    // Check MODULE
    if (this.matchesAny(text, tags, MODULE_KEYWORDS)) {
      return TaskClassification.MODULE;
    }

    return TaskClassification.LOCAL;
  }

  /**
   * Re-classify an existing task.
   */
  reclassify(task: Task): TaskClassification {
    return this.classify({
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      tags: task.tags,
    });
  }

  private matchesAny(text: string, tags: string[], keywords: string[]): boolean {
    return keywords.some((kw) => text.includes(kw) || tags.includes(kw));
  }
}
