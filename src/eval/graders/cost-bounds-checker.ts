export interface CostBoundsResult {
  withinBudget: boolean;
  totalCost: number;
  budgetLimit: number;
  overagePercent: number;
  costPerTask: number;
  taskCount: number;
}

/**
 * Validates that orchestration costs stayed within budget.
 */
export function checkCostBounds(
  totalCost: number,
  budgetLimit: number,
  taskCount: number,
): CostBoundsResult {
  const withinBudget = totalCost <= budgetLimit;
  const overagePercent = withinBudget
    ? 0
    : ((totalCost - budgetLimit) / budgetLimit) * 100;

  return {
    withinBudget,
    totalCost,
    budgetLimit,
    overagePercent,
    costPerTask: taskCount > 0 ? totalCost / taskCount : 0,
    taskCount,
  };
}
