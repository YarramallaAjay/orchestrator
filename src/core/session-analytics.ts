import { eq, sql } from 'drizzle-orm';
import { orchestratorSessions, taskMetrics } from '../db/schema.js';
import type { Db } from '../db/connection.js';

export interface SessionInsights {
  totalSessions: number;
  avgDurationMs: number;
  avgCostUsd: number;
  avgTasksPlanned: number;
  completionRate: number;
  failurePatterns: Array<{ status: string; count: number }>;
  costByEffort: Record<string, { avgCost: number; avgDuration: number; count: number }>;
}

/**
 * Analyzes historical orchestration sessions to provide insights
 * that improve future planning and execution.
 */
export class SessionAnalytics {
  constructor(private db: Db) {}

  async analyze(projectId: string): Promise<SessionInsights> {
    // Fetch all completed sessions for this project
    const sessions = this.db
      .select()
      .from(orchestratorSessions)
      .where(eq(orchestratorSessions.projectId, projectId))
      .all();

    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        avgDurationMs: 0,
        avgCostUsd: 0,
        avgTasksPlanned: 0,
        completionRate: 0,
        failurePatterns: [],
        costByEffort: {},
      };
    }

    const totalSessions = sessions.length;
    const avgDurationMs = sessions.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) / totalSessions;
    const avgCostUsd = sessions.reduce((sum, s) => sum + (s.totalCostUsd ?? 0), 0) / totalSessions;
    const avgTasksPlanned = sessions.reduce((sum, s) => sum + (s.tasksPlanned ?? 0), 0) / totalSessions;

    const totalCompleted = sessions.reduce((sum, s) => sum + (s.tasksCompleted ?? 0), 0);
    const totalPlanned = sessions.reduce((sum, s) => sum + (s.tasksPlanned ?? 0), 0);
    const completionRate = totalPlanned > 0 ? totalCompleted / totalPlanned : 0;

    // Failure patterns from task metrics
    const failurePatterns = this.db
      .select({
        status: taskMetrics.status,
        count: sql<number>`count(*)`,
      })
      .from(taskMetrics)
      .where(eq(taskMetrics.projectId, projectId))
      .groupBy(taskMetrics.status)
      .all();

    // Cost/duration by effort level (join with tasks table for effort info)
    const costByEffort: SessionInsights['costByEffort'] = {};

    // Query metrics grouped by task effort
    const effortMetrics = this.db.all(sql`
      SELECT
        t.estimated_effort as effort,
        AVG(tm.cost_usd) as avg_cost,
        AVG(tm.duration_ms) as avg_duration,
        COUNT(*) as count
      FROM task_metrics tm
      JOIN tasks t ON tm.task_id = t.id
      WHERE tm.project_id = ${projectId}
        AND t.estimated_effort IS NOT NULL
        AND tm.status = 'COMPLETED'
      GROUP BY t.estimated_effort
    `) as Array<{ effort: string; avg_cost: number; avg_duration: number; count: number }>;

    for (const row of effortMetrics) {
      costByEffort[row.effort] = {
        avgCost: row.avg_cost,
        avgDuration: row.avg_duration,
        count: row.count,
      };
    }

    return {
      totalSessions,
      avgDurationMs,
      avgCostUsd,
      avgTasksPlanned,
      completionRate,
      failurePatterns: failurePatterns.map((fp) => ({ status: fp.status, count: fp.count })),
      costByEffort,
    };
  }

  formatForPlannerPrompt(insights: SessionInsights): string {
    if (insights.totalSessions === 0) return '';

    const lines: string[] = [
      '## Historical Session Insights\n',
      `Based on ${insights.totalSessions} previous session(s):\n`,
      `- Average cost per session: $${insights.avgCostUsd.toFixed(4)}`,
      `- Average tasks planned: ${insights.avgTasksPlanned.toFixed(1)}`,
      `- Task completion rate: ${(insights.completionRate * 100).toFixed(0)}%`,
      `- Average session duration: ${(insights.avgDurationMs / 1000).toFixed(0)}s`,
    ];

    if (Object.keys(insights.costByEffort).length > 0) {
      lines.push('');
      lines.push('### Cost by Effort Level');
      for (const [effort, data] of Object.entries(insights.costByEffort)) {
        lines.push(`- **${effort}**: avg $${data.avgCost.toFixed(4)}, avg ${(data.avgDuration / 1000).toFixed(0)}s (${data.count} tasks)`);
      }
    }

    const failures = insights.failurePatterns.filter((f) => f.status === 'FAILED');
    if (failures.length > 0) {
      const failCount = failures.reduce((sum, f) => sum + f.count, 0);
      lines.push('');
      lines.push(`### Note: ${failCount} task(s) failed in previous sessions.`);
      lines.push('Consider breaking complex tasks into smaller units.');
    }

    return lines.join('\n');
  }
}
