import type { EventBus } from '../events/event-bus.js';
import { logger } from '../util/logger.js';

export interface CostSummary {
  totalUsd: number;
  byAgent: Record<string, number>;
  byTask: Record<string, number>;
  budgetUsd: number;
  budgetRemainingUsd: number;
  budgetExceeded: boolean;
}

/**
 * Tracks costs across agent executions and enforces budget limits.
 */
export class CostTracker {
  private agentCosts = new Map<string, number>();
  private taskCosts = new Map<string, number>();
  private totalCost = 0;

  constructor(
    private budgetUsd: number,
    private eventBus: EventBus,
  ) {
    this.setupEventHandlers();
  }

  /**
   * Record a cost for an agent execution on a task.
   */
  record(agentId: string, taskId: string, costUsd: number): void {
    this.totalCost += costUsd;
    this.agentCosts.set(agentId, (this.agentCosts.get(agentId) ?? 0) + costUsd);
    this.taskCosts.set(taskId, (this.taskCosts.get(taskId) ?? 0) + costUsd);

    if (this.isOverBudget()) {
      logger.warn({
        total: this.totalCost,
        budget: this.budgetUsd,
      }, 'Budget exceeded');

      this.eventBus.publish({
        id: '',
        type: 'budget.exceeded',
        source: 'cost-tracker',
        timestamp: new Date().toISOString(),
        projectId: '',
        payload: {
          totalCost: this.totalCost,
          budget: this.budgetUsd,
          excess: this.totalCost - this.budgetUsd,
        },
      });
    }
  }

  /**
   * Check if the budget has been exceeded.
   */
  isOverBudget(): boolean {
    return this.totalCost > this.budgetUsd;
  }

  /**
   * Get remaining budget.
   */
  remainingBudget(): number {
    return Math.max(0, this.budgetUsd - this.totalCost);
  }

  /**
   * Get a full cost summary.
   */
  getSummary(): CostSummary {
    return {
      totalUsd: this.totalCost,
      byAgent: Object.fromEntries(this.agentCosts),
      byTask: Object.fromEntries(this.taskCosts),
      budgetUsd: this.budgetUsd,
      budgetRemainingUsd: this.remainingBudget(),
      budgetExceeded: this.isOverBudget(),
    };
  }

  /**
   * Update the budget limit.
   */
  setBudget(budgetUsd: number): void {
    this.budgetUsd = budgetUsd;
  }

  /**
   * Reset all tracked costs.
   */
  reset(): void {
    this.totalCost = 0;
    this.agentCosts.clear();
    this.taskCosts.clear();
  }

  private setupEventHandlers(): void {
    // Auto-track costs from agent completion events
    this.eventBus.subscribe('agent.status_changed', (event) => {
      const payload = event.payload as any;
      if (payload.to === 'IDLE' && payload.costUsd) {
        this.record(
          payload.agentId ?? 'unknown',
          payload.taskId ?? 'unknown',
          payload.costUsd,
        );
      }
    });
  }
}
