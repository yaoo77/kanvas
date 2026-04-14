import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Result<T> {
  ok: true;
  data: T;
}

interface ErrorResult {
  ok: false;
  error: string;
}

type TaskResult<T> = Result<T> | ErrorResult;

export interface WorktreeInfo {
  worktreeDir: string;
  branch: string;
}

export interface DiffInfo {
  summary: string;
  diff: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKTREES_HOME = join(homedir(), ".kanvas", "tasks");

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function sanitizeForBranch(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function worktreeDirFor(sourceDir: string, taskId: string): string {
  const repoLabel = basename(sourceDir) || "workspace";
  return join(WORKTREES_HOME, taskId, repoLabel);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a git worktree for a task.
 *
 * A new branch `task/<taskId>` is created from the current HEAD of
 * `sourceDir`. The worktree is placed under `~/.kanvas/tasks/<taskId>/`.
 */
export function createTaskWorktree(
  sourceDir: string,
  taskId: string,
  taskName: string,
): TaskResult<WorktreeInfo> {
  try {
    const safeName = sanitizeForBranch(taskName);
    const branch = `task/${taskId}${safeName ? `-${safeName}` : ""}`;
    const worktreeDir = worktreeDirFor(sourceDir, taskId);

    // Ensure parent directory exists
    mkdirSync(join(worktreeDir, ".."), { recursive: true });

    // If the worktree already exists on disk, remove stale registration first
    if (existsSync(worktreeDir)) {
      try {
        git(sourceDir, `worktree remove --force "${worktreeDir}"`);
      } catch {
        // May fail if already gone from git's perspective
      }
      rmSync(worktreeDir, { recursive: true, force: true });
    }

    // Prune stale worktree bookkeeping
    try {
      git(sourceDir, "worktree prune");
    } catch {
      // non-critical
    }

    // Resolve HEAD to create from
    const baseCommit = git(sourceDir, "rev-parse HEAD");

    // Delete branch if it already exists (leftover from a previous attempt)
    try {
      git(sourceDir, `branch -D "${branch}"`);
    } catch {
      // branch didn't exist, fine
    }

    // Create worktree with a new branch
    git(sourceDir, `worktree add -b "${branch}" "${worktreeDir}" ${baseCommit}`);

    return {
      ok: true,
      data: { worktreeDir, branch },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove a task worktree and clean up its branch registration.
 */
export function removeTaskWorktree(
  sourceDir: string,
  worktreeDir: string,
): TaskResult<{ removed: boolean }> {
  try {
    const existed = existsSync(worktreeDir);

    if (existed) {
      try {
        git(sourceDir, `worktree remove --force "${worktreeDir}"`);
      } catch {
        // If `git worktree remove` fails, prune + rm manually
        try {
          git(sourceDir, "worktree prune");
        } catch {
          // non-critical
        }
      }
    }

    // Always attempt cleanup of the directory on disk
    rmSync(worktreeDir, { recursive: true, force: true });

    return { ok: true, data: { removed: existed } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Get a summary and full diff of all changes in the worktree
 * (staged + unstaged + untracked) relative to HEAD.
 */
export function getWorktreeDiff(worktreeDir: string): TaskResult<DiffInfo> {
  try {
    // Stat summary (tracked changes)
    let summary = "";
    try {
      summary = git(worktreeDir, "diff --stat HEAD");
    } catch {
      summary = "(no tracked changes)";
    }

    // Full diff of tracked changes
    let diff = "";
    try {
      diff = git(worktreeDir, "diff HEAD");
    } catch {
      // empty diff
    }

    // Append untracked files to the summary
    let untracked = "";
    try {
      untracked = git(worktreeDir, "ls-files --others --exclude-standard");
    } catch {
      // ignore
    }

    if (untracked) {
      const untrackedFiles = untracked
        .split("\n")
        .filter((f) => f.length > 0);
      if (untrackedFiles.length > 0) {
        summary += `\n\nUntracked files (${untrackedFiles.length}):\n${untrackedFiles.map((f) => `  ${f}`).join("\n")}`;

        // Generate diff for untracked files
        for (const file of untrackedFiles) {
          try {
            const fileDiff = git(
              worktreeDir,
              `diff --no-index -- /dev/null "${file}"`,
            );
            diff += `\n${fileDiff}`;
          } catch {
            // git diff --no-index exits 1 when there are differences;
            // execSync treats that as an error, so capture via try/catch
            try {
              const output = execSync(
                `git diff --no-index -- /dev/null "${file}"`,
                {
                  cwd: worktreeDir,
                  encoding: "utf8",
                  maxBuffer: 10 * 1024 * 1024,
                  stdio: ["pipe", "pipe", "pipe"],
                },
              );
              diff += `\n${output.trim()}`;
            } catch (innerErr: unknown) {
              // execSync throws on non-zero exit; stdout is in the error
              const execErr = innerErr as { stdout?: string };
              if (execErr.stdout) {
                diff += `\n${String(execErr.stdout).trim()}`;
              }
            }
          }
        }
      }
    }

    return {
      ok: true,
      data: { summary: summary || "(no changes)", diff },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Stage all changes and commit them in the worktree.
 */
export function commitWorktree(
  worktreeDir: string,
  message: string,
): TaskResult<{ commitHash: string }> {
  try {
    // Stage everything (tracked changes + untracked files)
    git(worktreeDir, "add -A");

    // Check if there is anything to commit
    try {
      git(worktreeDir, "diff --cached --quiet");
      // If the above succeeds (exit 0), there are no staged changes
      return { ok: false, error: "Nothing to commit." };
    } catch {
      // exit 1 means there are staged changes -- proceed
    }

    git(worktreeDir, `commit -m "${message.replace(/"/g, '\\"')}"`);
    const commitHash = git(worktreeDir, "rev-parse HEAD");

    return { ok: true, data: { commitHash } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Merge a worktree branch back into the current branch of sourceDir.
 *
 * Uses `--no-ff` so the merge is always recorded as a merge commit.
 */
export function mergeWorktreeBranch(
  sourceDir: string,
  branch: string,
): TaskResult<{ merged: boolean }> {
  try {
    git(sourceDir, `merge --no-ff "${branch}" -m "Merge ${branch}"`);
    return { ok: true, data: { merged: true } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
