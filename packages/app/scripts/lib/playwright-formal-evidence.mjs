/**
 * Resolves UI-smoke server reuse without allowing formal PR evidence to skip
 * the live-stack startup and fresh renderer build owned by Playwright.
 */

import { execFileSync } from "node:child_process";

export const FORMAL_EVIDENCE_REUSE_ERROR =
  "ELIZA_UI_SMOKE_REUSE_SERVER=1 cannot be combined with ELIZA_PR_EVIDENCE_HEAD; formal evidence must start the live stack and rebuild the renderer during this invocation.";
export const FORMAL_EVIDENCE_HEAD_ERROR =
  "ELIZA_PR_EVIDENCE_HEAD must be a full commit SHA that matches checked-out HEAD before Playwright starts its web server.";
export const FORMAL_EVIDENCE_DIRTY_ERROR =
  "Formal PR evidence requires a clean worktree before Playwright starts its web server.";

export function resolveUiSmokeReuseExistingServer(env) {
  const requestedEvidenceHead = env.ELIZA_PR_EVIDENCE_HEAD?.trim();
  const reuseExistingServer = env.ELIZA_UI_SMOKE_REUSE_SERVER === "1";

  if (requestedEvidenceHead && reuseExistingServer) {
    throw new Error(FORMAL_EVIDENCE_REUSE_ERROR);
  }

  return reuseExistingServer;
}

export function assertFormalEvidenceRepositoryState(
  env,
  repositoryRoot,
  runGit = (args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
) {
  const requestedEvidenceHead =
    env.ELIZA_PR_EVIDENCE_HEAD?.trim().toLowerCase();
  if (!requestedEvidenceHead) return null;
  if (!/^[a-f0-9]{40}$/.test(requestedEvidenceHead)) {
    throw new Error(FORMAL_EVIDENCE_HEAD_ERROR);
  }

  const repositoryHead = runGit(["rev-parse", "HEAD"]).trim().toLowerCase();
  if (repositoryHead !== requestedEvidenceHead) {
    throw new Error(FORMAL_EVIDENCE_HEAD_ERROR);
  }

  const worktreeStatus = runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]).trim();
  if (worktreeStatus.length > 0) {
    throw new Error(FORMAL_EVIDENCE_DIRTY_ERROR);
  }
  return repositoryHead;
}
