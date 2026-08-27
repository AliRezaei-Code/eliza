/**
 * Resolves UI-smoke server reuse without allowing formal PR evidence to skip
 * the live-stack startup and fresh renderer build owned by Playwright.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const FORMAL_EVIDENCE_BUILD_SKIP_INPUTS = [
  "ELIZA_UI_SMOKE_SKIP_BUILD",
  "ELIZA_UI_SMOKE_SKIP_VIEW_BUILD",
  "ELIZA_UI_SMOKE_SKIP_CORE_BUILD",
];
const FORMAL_EVIDENCE_VITE_ENV_INPUTS = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.production.local",
]);

export const FORMAL_EVIDENCE_REUSE_ERROR =
  "ELIZA_UI_SMOKE_REUSE_SERVER=1 cannot be combined with ELIZA_PR_EVIDENCE_HEAD; formal evidence must start the live stack and rebuild the renderer during this invocation.";
export const FORMAL_EVIDENCE_HEAD_ERROR =
  "ELIZA_PR_EVIDENCE_HEAD must be a full commit SHA that matches checked-out HEAD before Playwright starts its web server.";
export const FORMAL_EVIDENCE_DIRTY_ERROR =
  "Formal PR evidence requires a clean worktree before Playwright starts its web server.";
export const FORMAL_EVIDENCE_BUILD_SKIP_ERROR =
  "Formal PR evidence cannot enable a UI-smoke build-skip input; the renderer, views, and linked shared/core packages must be rebuilt during this invocation.";
export const FORMAL_EVIDENCE_VITE_ENV_ERROR =
  "Formal PR evidence cannot use a local packages/app Vite env file; the production renderer must be built from the controlled process environment only.";
export const PLAYWRIGHT_CONFIG_ARGUMENT_ERROR =
  "Playwright --config/-c requires a non-empty configuration path.";
export const FORMAL_EVIDENCE_CONFIG_AMBIGUITY_ERROR =
  "Formal PR evidence does not accept multiple Playwright --config/-c declarations.";
export const FORMAL_EVIDENCE_CONFIG_ERROR =
  "Formal PR evidence requires the existing canonical packages/app/playwright.ui-smoke.config.ts configuration.";

/**
 * Resolve Playwright's single-valued `-c, --config <file>` option from the
 * argument vector forwarded by this runner. Commander accepts split long and
 * short forms, `--config=<file>`, and a value attached to `-c`; arguments after
 * `--` are positional test filters and must not be interpreted as options.
 */
export function resolvePlaywrightConfigArgument(
  args,
  { rejectMultiple = false } = {},
) {
  const declarations = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;

    if (arg === "--config" || arg === "-c") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(PLAYWRIGHT_CONFIG_ARGUMENT_ERROR);
      }
      declarations.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) {
        throw new Error(PLAYWRIGHT_CONFIG_ARGUMENT_ERROR);
      }
      declarations.push(value);
      continue;
    }

    if (arg.startsWith("-c") && !arg.startsWith("--") && arg.length > 2) {
      declarations.push(arg.slice(2));
    }
  }

  if (rejectMultiple && declarations.length > 1) {
    throw new Error(FORMAL_EVIDENCE_CONFIG_AMBIGUITY_ERROR);
  }

  return declarations.at(-1) ?? null;
}

/**
 * Formal evidence is defined only for the canonical UI-smoke lane. Resolve the
 * selected file before any build and refuse missing, alternate, or ambiguous
 * configuration input instead of letting Playwright load a config whose setup
 * branches this launcher did not execute.
 */
export function resolveFormalEvidencePlaywrightConfig(
  env,
  args,
  appDirectory,
  resolveRealPath = (filePath) => realpathSync.native(filePath),
) {
  const formalEvidence = Boolean(env.ELIZA_PR_EVIDENCE_HEAD?.trim());
  const selectedConfig = resolvePlaywrightConfigArgument(args, {
    rejectMultiple: formalEvidence,
  });
  if (!formalEvidence) return selectedConfig;
  if (!selectedConfig) {
    throw new Error(FORMAL_EVIDENCE_CONFIG_ERROR);
  }

  try {
    const selectedPath = resolveRealPath(
      path.resolve(appDirectory, selectedConfig),
    );
    const canonicalPath = resolveRealPath(
      path.resolve(appDirectory, "playwright.ui-smoke.config.ts"),
    );
    if (selectedPath !== canonicalPath) {
      throw new Error(FORMAL_EVIDENCE_CONFIG_ERROR);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === FORMAL_EVIDENCE_CONFIG_ERROR
    ) {
      throw error;
    }
    throw new Error(FORMAL_EVIDENCE_CONFIG_ERROR, { cause: error });
  }

  return selectedConfig;
}

/**
 * Describe the linked package build without performing filesystem or process
 * mutations. The caller may set `formalEvidenceValidated` only after config,
 * repository, and server-reuse preflight all return successfully.
 */
export function resolveLinkedRendererBuildPlan(
  repositoryRoot,
  { formalEvidenceValidated = false } = {},
) {
  const turboArgs = [
    path.join(repositoryRoot, "packages", "scripts", "run-turbo.mjs"),
    "run",
    "build",
    "--filter=@elizaos/shared",
    "--filter=@elizaos/core",
  ];

  return {
    cleanupOutputDirs: formalEvidenceValidated
      ? [
          path.join(repositoryRoot, "packages", "shared", "dist"),
          path.join(repositoryRoot, "packages", "core", "dist"),
        ]
      : [],
    turboArgs: formalEvidenceValidated ? [...turboArgs, "--force"] : turboArgs,
  };
}

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
  listAppDirectory = () =>
    readdirSync(path.join(repositoryRoot, "packages", "app")),
) {
  const requestedEvidenceHead =
    env.ELIZA_PR_EVIDENCE_HEAD?.trim().toLowerCase();
  if (!requestedEvidenceHead) return null;

  const enabledBuildSkipInputs = FORMAL_EVIDENCE_BUILD_SKIP_INPUTS.filter(
    (name) => env[name] === "1",
  );
  if (enabledBuildSkipInputs.length > 0) {
    throw new Error(
      `${FORMAL_EVIDENCE_BUILD_SKIP_ERROR} Enabled: ${enabledBuildSkipInputs.join(", ")}.`,
    );
  }

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

  const localViteEnvInputs = listAppDirectory()
    // A case-insensitive filesystem also resolves `.ENV` when Vite opens
    // `.env`; normalize here so the guard behaves the same on every runner.
    .filter((name) => FORMAL_EVIDENCE_VITE_ENV_INPUTS.has(name.toLowerCase()))
    .sort();
  if (localViteEnvInputs.length > 0) {
    throw new Error(
      `${FORMAL_EVIDENCE_VITE_ENV_ERROR} Found: ${localViteEnvInputs.join(", ")}.`,
    );
  }
  return repositoryHead;
}
