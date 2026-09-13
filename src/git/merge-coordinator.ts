import type { WorktreeManager, MergeResult, WorktreeInfo } from './worktree-manager.js';
import { logger } from '../util/logger.js';

export interface IntegrationPlan {
  order: WorktreeInfo[];
  conflicts: Array<{ worktreeA: string; worktreeB: string; files: string[] }>;
}

/**
 * Coordinates the merge of multiple worktree branches back into the integration branch.
 * Handles conflict detection, ordering, and staged merging.
 */
export class MergeCoordinator {
  constructor(private worktreeManager: WorktreeManager) {}

  /**
   * Plan the integration of all active worktrees.
   * Detects potential conflicts between worktrees before merging.
   */
  async planIntegration(): Promise<IntegrationPlan> {
    const active = (await this.worktreeManager.list()).filter(
      (wt) => wt.status === 'ACTIVE',
    );

    // Check for conflicts between each pair
    const conflicts: IntegrationPlan['conflicts'] = [];
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const wtA = active[i]!;
        const wtB = active[j]!;
        const conflictInfo = await this.worktreeManager.detectConflicts(wtA.id);
        if (conflictInfo.length > 0) {
          conflicts.push({
            worktreeA: wtA.id,
            worktreeB: wtB.id,
            files: conflictInfo.map((c) => c.file),
          });
        }
      }
    }

    return { order: active, conflicts };
  }

  /**
   * Execute integration: merge worktrees sequentially in the given order.
   * Returns results for each merge attempt.
   */
  async executeIntegration(
    worktreeIds: string[],
    options: {
      stopOnConflict?: boolean;
      targetBranch?: string;
    } = {},
  ): Promise<Map<string, MergeResult>> {
    const results = new Map<string, MergeResult>();

    for (const wtId of worktreeIds) {
      logger.info({ worktreeId: wtId }, 'Merging worktree');

      const result = await this.worktreeManager.merge(wtId, options.targetBranch);
      results.set(wtId, result);

      if (!result.success && options.stopOnConflict) {
        logger.warn({ worktreeId: wtId }, 'Stopping integration due to conflicts');
        break;
      }
    }

    return results;
  }

  /**
   * Merge a single worktree with conflict handling.
   */
  async mergeSingle(worktreeId: string, targetBranch?: string): Promise<MergeResult> {
    // First detect conflicts
    const conflicts = await this.worktreeManager.detectConflicts(worktreeId, targetBranch);
    if (conflicts.length > 0) {
      logger.warn({ worktreeId, conflicts: conflicts.length }, 'Potential conflicts detected');
    }

    return this.worktreeManager.merge(worktreeId, targetBranch);
  }
}
