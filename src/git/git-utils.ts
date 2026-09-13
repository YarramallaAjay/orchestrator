import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Execute a git command in the specified directory.
 */
export async function git(args: string[], cwd: string): Promise<GitExecResult> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    timeout: 60_000,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Check if a directory is inside a git repository.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the root directory of the git repository.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--show-toplevel'], cwd);
  return stdout;
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return stdout;
}

/**
 * Get the current commit hash.
 */
export async function getHeadCommit(cwd: string): Promise<string> {
  const { stdout } = await git(['rev-parse', 'HEAD'], cwd);
  return stdout;
}

/**
 * Check if there are uncommitted changes.
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await git(['status', '--porcelain'], cwd);
  return stdout.length > 0;
}

/**
 * List existing worktrees.
 */
export async function listWorktrees(cwd: string): Promise<Array<{ path: string; branch: string; commit: string }>> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], cwd);
  const worktrees: Array<{ path: string; branch: string; commit: string }> = [];

  let current: { path: string; branch: string; commit: string } = { path: '', branch: '', commit: '' };

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.substring(9), branch: '', commit: '' };
    } else if (line.startsWith('HEAD ')) {
      current.commit = line.substring(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7).replace('refs/heads/', '');
    } else if (line === '') {
      if (current.path) {
        worktrees.push(current);
        current = { path: '', branch: '', commit: '' };
      }
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees;
}

/**
 * Create a new branch.
 */
export async function createBranch(cwd: string, branchName: string, startPoint?: string): Promise<void> {
  const args = ['branch', branchName];
  if (startPoint) args.push(startPoint);
  await git(args, cwd);
}

/**
 * Check if a branch exists.
 */
export async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', branchName], cwd);
    return true;
  } catch {
    return false;
  }
}
