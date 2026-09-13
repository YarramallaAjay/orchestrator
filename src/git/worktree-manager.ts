import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/connection.js';
import { worktrees } from '../db/schema.js';
import type { Task } from '../task/types.js';
import { generateId } from '../util/id.js';
import { logger } from '../util/logger.js';
import { git, branchExists, getRepoRoot } from './git-utils.js';

export interface WorktreeInfo {
  id: string;
  projectId: string;
  path: string;
  branch: string;
  taskId: string | null;
  agentId: string | null;
  status: 'ACTIVE' | 'MERGED' | 'ABANDONED';
  createdAt: string;
  mergedAt: string | null;
}

export interface MergeResult {
  success: boolean;
  conflicts: ConflictInfo[];
  mergeCommit: string | null;
}

export interface ConflictInfo {
  file: string;
  type: 'content' | 'rename' | 'delete';
  description: string;
}

export class WorktreeManager {
  constructor(
    private db: Db,
    private config: {
      projectId: string;
      rootPath: string;
      worktreeDir: string;
      branchPrefix: string;
      integrationBranch: string;
    },
  ) {}

  /**
   * Create a new worktree for a task.
   */
  async create(task: Task, agentId?: string): Promise<WorktreeInfo> {
    const repoRoot = await getRepoRoot(this.config.rootPath);
    const worktreeBase = resolve(repoRoot, this.config.worktreeDir);
    mkdirSync(worktreeBase, { recursive: true });

    // Generate branch and path
    const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30);
    const branchName = `${this.config.branchPrefix}${slug}-${task.id.substring(5, 13)}`;
    const worktreePath = resolve(worktreeBase, `${slug}-${task.id.substring(5, 13)}`);

    // Create branch if it doesn't exist
    if (!(await branchExists(repoRoot, branchName))) {
      await git(['branch', branchName], repoRoot);
    }

    // Create worktree
    await git(['worktree', 'add', worktreePath, branchName], repoRoot);

    const id = generateId('wt');
    const now = new Date().toISOString();

    this.db.insert(worktrees).values({
      id,
      projectId: this.config.projectId,
      path: worktreePath,
      branch: branchName,
      taskId: task.id,
      agentId: agentId ?? null,
      status: 'ACTIVE',
      createdAt: now,
    }).run();

    logger.info({ id, branch: branchName, path: worktreePath }, 'Worktree created');

    return {
      id,
      projectId: this.config.projectId,
      path: worktreePath,
      branch: branchName,
      taskId: task.id,
      agentId: agentId ?? null,
      status: 'ACTIVE',
      createdAt: now,
      mergedAt: null,
    };
  }

  /**
   * List all worktrees for the project.
   */
  async list(): Promise<WorktreeInfo[]> {
    return this.db
      .select()
      .from(worktrees)
      .where(eq(worktrees.projectId, this.config.projectId))
      .all()
      .map(this.rowToInfo);
  }

  /**
   * Get a worktree by ID.
   */
  async getById(id: string): Promise<WorktreeInfo | null> {
    const rows = this.db.select().from(worktrees).where(eq(worktrees.id, id)).all();
    return rows[0] ? this.rowToInfo(rows[0]) : null;
  }

  /**
   * Merge a worktree branch back to the integration branch.
   */
  async merge(worktreeId: string, targetBranch?: string): Promise<MergeResult> {
    const wt = await this.getById(worktreeId);
    if (!wt) throw new Error(`Worktree not found: ${worktreeId}`);

    const target = targetBranch ?? this.config.integrationBranch;
    const repoRoot = await getRepoRoot(this.config.rootPath);

    try {
      // Merge the worktree branch into the target branch
      await git(['checkout', target], repoRoot);
      const result = await git(['merge', '--no-ff', wt.branch, '-m', `Merge ${wt.branch} into ${target}`], repoRoot);

      // Get merge commit
      const { stdout: commitHash } = await git(['rev-parse', 'HEAD'], repoRoot);

      // Update worktree status
      this.db.update(worktrees).set({
        status: 'MERGED',
        mergedAt: new Date().toISOString(),
      }).where(eq(worktrees.id, worktreeId)).run();

      logger.info({ worktreeId, branch: wt.branch, target }, 'Worktree merged');

      return {
        success: true,
        conflicts: [],
        mergeCommit: commitHash,
      };
    } catch (error: any) {
      // Check for conflicts
      const stderr = error.stderr ?? error.message ?? '';
      if (stderr.includes('CONFLICT') || stderr.includes('Automatic merge failed')) {
        // Abort the failed merge
        try {
          await git(['merge', '--abort'], repoRoot);
        } catch { /* ignore */ }

        const conflicts = this.parseConflicts(stderr);
        logger.warn({ worktreeId, conflicts: conflicts.length }, 'Merge conflicts detected');

        return {
          success: false,
          conflicts,
          mergeCommit: null,
        };
      }

      throw error;
    }
  }

  /**
   * Detect conflicts between a worktree branch and target without merging.
   */
  async detectConflicts(worktreeId: string, targetBranch?: string): Promise<ConflictInfo[]> {
    const wt = await this.getById(worktreeId);
    if (!wt) throw new Error(`Worktree not found: ${worktreeId}`);

    const target = targetBranch ?? this.config.integrationBranch;
    const repoRoot = await getRepoRoot(this.config.rootPath);

    try {
      // Use merge-tree to check for conflicts without actually merging
      const { stdout } = await git(['merge-tree', target, wt.branch], repoRoot);

      if (stdout.includes('<<<<<<')) {
        return [{ file: 'unknown', type: 'content', description: 'Merge conflict detected via merge-tree' }];
      }

      return [];
    } catch {
      return [{ file: 'unknown', type: 'content', description: 'Could not determine conflict status' }];
    }
  }

  /**
   * Remove a worktree and optionally delete the branch.
   */
  async remove(worktreeId: string, deleteBranch: boolean = false): Promise<void> {
    const wt = await this.getById(worktreeId);
    if (!wt) throw new Error(`Worktree not found: ${worktreeId}`);

    const repoRoot = await getRepoRoot(this.config.rootPath);

    // Remove the worktree
    if (existsSync(wt.path)) {
      await git(['worktree', 'remove', wt.path, '--force'], repoRoot);
    }

    // Optionally delete the branch
    if (deleteBranch) {
      try {
        await git(['branch', '-D', wt.branch], repoRoot);
      } catch { /* branch may not exist */ }
    }

    // Update DB
    this.db.update(worktrees).set({ status: 'ABANDONED' }).where(eq(worktrees.id, worktreeId)).run();

    logger.info({ worktreeId, branch: wt.branch }, 'Worktree removed');
  }

  /**
   * Clean up all merged or abandoned worktrees.
   */
  async cleanup(): Promise<number> {
    const all = await this.list();
    let cleaned = 0;

    for (const wt of all) {
      if (wt.status === 'MERGED' || wt.status === 'ABANDONED') {
        if (existsSync(wt.path)) {
          try {
            const repoRoot = await getRepoRoot(this.config.rootPath);
            await git(['worktree', 'remove', wt.path, '--force'], repoRoot);
          } catch { /* ignore */ }
        }
        this.db.delete(worktrees).where(eq(worktrees.id, wt.id)).run();
        cleaned++;
      }
    }

    // Prune worktree references
    try {
      const repoRoot = await getRepoRoot(this.config.rootPath);
      await git(['worktree', 'prune'], repoRoot);
    } catch { /* ignore */ }

    return cleaned;
  }

  private parseConflicts(stderr: string): ConflictInfo[] {
    const conflicts: ConflictInfo[] = [];
    const lines = stderr.split('\n');

    for (const line of lines) {
      const match = line.match(/CONFLICT \((\w+)\):\s*(.*)/);
      if (match) {
        conflicts.push({
          file: match[2] ?? 'unknown',
          type: match[1] === 'content' ? 'content' : match[1] === 'rename' ? 'rename' : 'delete',
          description: line.trim(),
        });
      }
    }

    return conflicts;
  }

  private rowToInfo(row: typeof worktrees.$inferSelect): WorktreeInfo {
    return {
      id: row.id,
      projectId: row.projectId,
      path: row.path,
      branch: row.branch,
      taskId: row.taskId,
      agentId: row.agentId,
      status: row.status as WorktreeInfo['status'],
      createdAt: row.createdAt,
      mergedAt: row.mergedAt,
    };
  }
}
