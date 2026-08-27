/**
 * Resolves UI-smoke server reuse without allowing formal PR evidence to skip
 * the live-stack startup and fresh renderer build owned by Playwright.
 */

export const FORMAL_EVIDENCE_REUSE_ERROR =
  "ELIZA_UI_SMOKE_REUSE_SERVER=1 cannot be combined with ELIZA_PR_EVIDENCE_HEAD; formal evidence must start the live stack and rebuild the renderer during this invocation.";

export function resolveUiSmokeReuseExistingServer(env) {
  const requestedEvidenceHead = env.ELIZA_PR_EVIDENCE_HEAD?.trim();
  const reuseExistingServer = env.ELIZA_UI_SMOKE_REUSE_SERVER === "1";

  if (requestedEvidenceHead && reuseExistingServer) {
    throw new Error(FORMAL_EVIDENCE_REUSE_ERROR);
  }

  return reuseExistingServer;
}
