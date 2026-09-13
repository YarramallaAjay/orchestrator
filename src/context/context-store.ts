import type { Task } from '../task/types.js';
import type { ContextRepository } from './context-repository.js';
import { ContextCategory, type ContextEntry } from './types.js';

/**
 * High-level context store that wraps ContextRepository
 * and provides agent-context building capabilities.
 */
export class ContextStore {
  constructor(private repo: ContextRepository) {}

  async set(entry: {
    projectId: string;
    key: string;
    category: ContextCategory;
    title: string;
    content: string;
    updatedBy: string;
  }): Promise<ContextEntry> {
    return this.repo.set(entry);
  }

  async get(projectId: string, key: string): Promise<ContextEntry | null> {
    return this.repo.get(projectId, key);
  }

  async list(projectId: string, category?: ContextCategory): Promise<ContextEntry[]> {
    return this.repo.list(projectId, category);
  }

  async delete(projectId: string, key: string): Promise<void> {
    return this.repo.delete(projectId, key);
  }

  /**
   * Build a context snapshot relevant to a specific task.
   * Includes: requirements, architecture decisions, API contracts,
   * conventions, and any context matching the task's tags.
   */
  async buildAgentContext(projectId: string, task: Task): Promise<string> {
    const allContext = await this.repo.list(projectId);
    if (allContext.length === 0) return '';

    // Always include requirements, architecture, and conventions
    const alwaysInclude = new Set([
      ContextCategory.REQUIREMENTS,
      ContextCategory.ARCHITECTURE,
      ContextCategory.CONVENTION,
    ]);

    // Filter context relevant to this task
    const relevant = allContext.filter((entry) => {
      // Always include foundational context
      if (alwaysInclude.has(entry.category as ContextCategory)) return true;

      // Include API contracts and dependencies that might be relevant
      if (entry.category === ContextCategory.API_CONTRACT) return true;
      if (entry.category === ContextCategory.DEPENDENCY) return true;

      // Include decisions
      if (entry.category === ContextCategory.DECISION) return true;

      // Check if the context key matches any task tags
      if (task.tags.some((tag) => entry.key.includes(tag))) return true;

      return false;
    });

    if (relevant.length === 0) return '';

    const sections: string[] = ['# Shared Project Context\n'];

    // Group by category
    const grouped = new Map<string, ContextEntry[]>();
    for (const entry of relevant) {
      const group = grouped.get(entry.category) ?? [];
      group.push(entry);
      grouped.set(entry.category, group);
    }

    for (const [category, entries] of grouped) {
      sections.push(`## ${category}\n`);
      for (const entry of entries) {
        sections.push(`### ${entry.title} (${entry.key})\n`);
        sections.push(entry.content);
        sections.push('');
      }
    }

    return sections.join('\n');
  }
}
