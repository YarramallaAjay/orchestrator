import { eq, and } from 'drizzle-orm';
import { observations } from '../db/schema.js';
import { generateId } from '../util/id.js';
import type { Db } from '../db/connection.js';
import type { AgentRunResult } from '../agent/runtimes/runtime.js';

export interface Observation {
  id: string;
  projectId: string;
  taskId: string;
  agentId: string;
  type: 'pattern' | 'convention' | 'warning' | 'discovery';
  content: string;
  relevantFiles: string[];
  confidence: number;
  createdAt: string;
}

/**
 * Stores and retrieves observations made by agents during task execution.
 * Enables knowledge sharing between agents across tasks.
 */
export class ObservationStore {
  constructor(private db: Db) {}

  async add(obs: Omit<Observation, 'id' | 'createdAt'>): Promise<Observation> {
    const id = generateId('obs');
    const createdAt = new Date().toISOString();

    this.db.insert(observations).values({
      id,
      projectId: obs.projectId,
      taskId: obs.taskId,
      agentId: obs.agentId,
      type: obs.type,
      content: obs.content,
      relevantFiles: JSON.stringify(obs.relevantFiles),
      confidence: obs.confidence,
      createdAt,
    }).run();

    return { ...obs, id, createdAt };
  }

  async findRelevant(projectId: string, files?: string[]): Promise<Observation[]> {
    const rows = this.db
      .select()
      .from(observations)
      .where(eq(observations.projectId, projectId))
      .all();

    let results = rows.map(this.mapRow);

    // Filter by file relevance if files are provided
    if (files && files.length > 0) {
      const fileSet = new Set(files);
      results = results.filter((obs) => {
        if (obs.relevantFiles.length === 0) return true; // Generic observations always included
        return obs.relevantFiles.some((f) => fileSet.has(f));
      });
    }

    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);

    return results;
  }

  /**
   * Extract observations from agent messages using regex patterns.
   */
  extractFromResult(
    result: AgentRunResult,
    meta: { projectId: string; taskId: string; agentId: string },
  ): Omit<Observation, 'id' | 'createdAt'>[] {
    const extracted: Omit<Observation, 'id' | 'createdAt'>[] = [];

    const patterns: Array<{ regex: RegExp; type: Observation['type']; confidence: number }> = [
      { regex: /(?:I noticed|I found|Note:)\s+(.{15,200})/i, type: 'discovery', confidence: 0.6 },
      { regex: /(?:Convention:|This project uses|The codebase follows)\s+(.{15,200})/i, type: 'convention', confidence: 0.7 },
      { regex: /(?:Warning:|Be careful|Watch out|Caution:)\s+(.{15,200})/i, type: 'warning', confidence: 0.8 },
      { regex: /(?:Pattern:|The pattern here is|This follows the pattern)\s+(.{15,200})/i, type: 'pattern', confidence: 0.7 },
    ];

    for (const msg of result.messages) {
      if (msg.role !== 'assistant' || !msg.content) continue;

      for (const { regex, type, confidence } of patterns) {
        const match = msg.content.match(regex);
        if (match && match[1]) {
          extracted.push({
            projectId: meta.projectId,
            taskId: meta.taskId,
            agentId: meta.agentId,
            type,
            content: match[1].trim(),
            relevantFiles: [],
            confidence,
          });
        }
      }
    }

    return extracted;
  }

  formatForContext(obs: Observation[]): string {
    if (obs.length === 0) return '';

    const lines: string[] = ['## Agent Observations\n'];

    const grouped = new Map<string, Observation[]>();
    for (const o of obs) {
      const group = grouped.get(o.type) ?? [];
      group.push(o);
      grouped.set(o.type, group);
    }

    const typeLabels: Record<string, string> = {
      convention: 'Conventions',
      pattern: 'Patterns',
      warning: 'Warnings',
      discovery: 'Discoveries',
    };

    for (const [type, items] of grouped) {
      lines.push(`### ${typeLabels[type] ?? type}\n`);
      for (const item of items) {
        lines.push(`- ${item.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private mapRow(row: any): Observation {
    return {
      id: row.id,
      projectId: row.projectId,
      taskId: row.taskId,
      agentId: row.agentId,
      type: row.type as Observation['type'],
      content: row.content,
      relevantFiles: JSON.parse(row.relevantFiles ?? '[]'),
      confidence: row.confidence,
      createdAt: row.createdAt,
    };
  }
}
