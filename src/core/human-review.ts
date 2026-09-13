import type { Task } from '../task/types.js';
import { TaskStatus } from '../task/types.js';
import type { TaskRepository } from '../task/task-repository.js';
import type { EventBus } from '../events/event-bus.js';
import { generateId } from '../util/id.js';
import { logger } from '../util/logger.js';

export interface HumanReviewRequest {
  id: string;
  taskId: string;
  projectId: string;
  reason: string;
  details: string;
  options: string[];
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

/**
 * Manages human-in-the-loop approval flows.
 * Tasks requiring human review are paused until approved.
 */
export class HumanReviewManager {
  private pendingReviews = new Map<string, HumanReviewRequest>();

  constructor(
    private taskRepo: TaskRepository,
    private eventBus: EventBus,
  ) {}

  /**
   * Request human review for a task.
   * Transitions the task to WAITING_FOR_HUMAN.
   */
  async requestReview(
    task: Task,
    reason: string,
    details: string,
    options: string[] = ['approve', 'reject', 'modify'],
  ): Promise<HumanReviewRequest> {
    const review: HumanReviewRequest = {
      id: generateId('review'),
      taskId: task.id,
      projectId: task.projectId,
      reason,
      details,
      options,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      resolution: null,
    };

    this.pendingReviews.set(review.id, review);

    // Transition task to waiting
    await this.taskRepo.transition(task.id, TaskStatus.WAITING_FOR_HUMAN);

    await this.eventBus.publish({
      id: generateId('evt'),
      type: 'review.requested',
      source: 'orchestrator',
      timestamp: new Date().toISOString(),
      projectId: task.projectId,
      payload: {
        reviewId: review.id,
        taskId: task.id,
        reason,
        options,
      },
    });

    logger.info({ reviewId: review.id, taskId: task.id, reason }, 'Human review requested');
    return review;
  }

  /**
   * Resolve a pending review.
   */
  async resolve(reviewId: string, resolution: string): Promise<void> {
    const review = this.pendingReviews.get(reviewId);
    if (!review) {
      throw new Error(`Review not found: ${reviewId}`);
    }

    review.resolvedAt = new Date().toISOString();
    review.resolution = resolution;

    if (resolution === 'approve') {
      // Resume task execution
      await this.taskRepo.transition(review.taskId, TaskStatus.RUNNING);
    } else if (resolution === 'reject') {
      // Cancel the task
      await this.taskRepo.transition(review.taskId, TaskStatus.CANCELLED);
    } else {
      // For 'modify' or custom resolutions, keep as waiting
      // The task's input context should be updated with the modification details
    }

    this.pendingReviews.delete(reviewId);

    await this.eventBus.publish({
      id: generateId('evt'),
      type: 'review.resolved',
      source: 'human',
      timestamp: new Date().toISOString(),
      projectId: review.projectId,
      payload: {
        reviewId,
        taskId: review.taskId,
        resolution,
      },
    });

    logger.info({ reviewId, resolution }, 'Human review resolved');
  }

  /**
   * List pending reviews.
   */
  listPending(): HumanReviewRequest[] {
    return [...this.pendingReviews.values()].filter((r) => !r.resolvedAt);
  }

  /**
   * Get a review by ID.
   */
  getReview(reviewId: string): HumanReviewRequest | null {
    return this.pendingReviews.get(reviewId) ?? null;
  }

  /**
   * Check if a task requires human review based on its classification.
   */
  requiresReview(task: Task): boolean {
    return task.classification === 'HUMAN_IN_THE_LOOP';
  }
}
