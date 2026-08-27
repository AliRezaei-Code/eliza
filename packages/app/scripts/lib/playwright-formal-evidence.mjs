/**
 * Resolves UI-smoke server reuse without allowing formal PR evidence to skip
 * the live-stack startup and fresh renderer build owned by Playwright.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverViewBundleInventory } from "../../../scripts/lib/view-bundle-inventory.mjs";

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
export const FORMAL_EVIDENCE_PREPARATION_ERROR =
  "Formal PR evidence requires a fresh wrapper-validated cleanup and rebuild before Playwright can load its config.";
export const FORMAL_EVIDENCE_PREPARATION_RECEIPT_ENV =
  "ELIZA_PR_EVIDENCE_PREPARATION_RECEIPT";
export const FORMAL_EVIDENCE_PREPARATION_NONCE_ENV =
  "ELIZA_PR_EVIDENCE_PREPARATION_NONCE";

const FORMAL_EVIDENCE_PREPARATION_SCHEMA =
  "elizaos.playwright.formal-preparation/v1";
const FORMAL_EVIDENCE_PREPARATION_RECEIPT_PREFIX = "eliza-formal-evidence-";
const FORMAL_EVIDENCE_PREPARATION_MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1_000;
const FORMAL_EVIDENCE_PREPARATION_INVALID_GRACE_MS = 5 * 60 * 1_000;
const FORMAL_EVIDENCE_PREPARATION_CLOCK_SKEW_MS = 60 * 1_000;
const FORMAL_EVIDENCE_OUTPUT_MTIME_TOLERANCE_MS = 2_000;
const FORMAL_EVIDENCE_LINKED_OUTPUT_ROOTS = [
  "packages/core/dist",
  "packages/shared/dist",
];

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

function throwFormalEvidencePreparationError() {
  throw new Error(FORMAL_EVIDENCE_PREPARATION_ERROR);
}

function resolveContainedOutput(repositoryRoot, filePath) {
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(repositoryRoot, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throwFormalEvidencePreparationError();
  }
  return {
    absolutePath,
    relativePath,
    portablePath: relativePath.split(path.sep).join("/"),
  };
}

function assertUnsymbolicPath(repositoryRoot, filePath, finalType) {
  const output = resolveContainedOutput(repositoryRoot, filePath);
  let currentPath = repositoryRoot;
  const segments = output.relativePath.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throwFormalEvidencePreparationError();
    }
    const expectedType =
      index === segments.length - 1 ? finalType : "directory";
    if (
      (expectedType === "file" && !stats.isFile()) ||
      (expectedType === "directory" && !stats.isDirectory())
    ) {
      throwFormalEvidencePreparationError();
    }
  }
  return output;
}

function collectLinkedOutputFiles(repositoryRoot, outputRoot) {
  const root = assertUnsymbolicPath(repositoryRoot, outputRoot, "directory");

  const files = [];
  const visit = (directoryPath) => {
    const entryNames = readdirSync(directoryPath).sort();
    for (const entryName of entryNames) {
      const entry = resolveContainedOutput(
        repositoryRoot,
        path.join(directoryPath, entryName),
      );
      const stats = lstatSync(entry.absolutePath);
      if (stats.isSymbolicLink()) {
        throwFormalEvidencePreparationError();
      }
      if (stats.isDirectory()) {
        visit(entry.absolutePath);
      } else if (stats.isFile()) {
        files.push(entry.absolutePath);
      } else {
        throwFormalEvidencePreparationError();
      }
    }
  };
  visit(root.absolutePath);
  if (files.length === 0) {
    throwFormalEvidencePreparationError();
  }
  return files;
}

function assertRegularViewBundle(repositoryRoot, filePath) {
  return assertUnsymbolicPath(repositoryRoot, filePath, "file").absolutePath;
}

function resolveFormalEvidenceOutputFiles(repositoryRoot, viewBundleFiles) {
  const linkedFiles = FORMAL_EVIDENCE_LINKED_OUTPUT_ROOTS.flatMap(
    (relativePath) =>
      collectLinkedOutputFiles(
        repositoryRoot,
        path.join(repositoryRoot, ...relativePath.split("/")),
      ),
  );
  const discoveredViewFiles =
    viewBundleFiles ??
    discoverViewBundleInventory({ repoRoot: repositoryRoot }).targets.map(
      (target) => target.bundleAbsolute,
    );
  if (discoveredViewFiles.length === 0) {
    throwFormalEvidencePreparationError();
  }

  const normalizedFiles = new Map();
  for (const filePath of [
    ...linkedFiles,
    ...discoveredViewFiles.map((viewPath) =>
      assertRegularViewBundle(repositoryRoot, viewPath),
    ),
  ]) {
    const { absolutePath, portablePath } = resolveContainedOutput(
      repositoryRoot,
      filePath,
    );
    if (normalizedFiles.has(portablePath)) {
      throwFormalEvidencePreparationError();
    }
    normalizedFiles.set(portablePath, absolutePath);
  }

  return [...normalizedFiles.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([relativePath, absolutePath]) => ({
      absolutePath,
      relativePath,
    }));
}

function fingerprintFormalEvidenceOutput(output, startedAtMs) {
  let stats;
  let bytes;
  try {
    stats = lstatSync(output.absolutePath);
    bytes = readFileSync(output.absolutePath);
  } catch {
    throwFormalEvidencePreparationError();
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throwFormalEvidencePreparationError();
  }

  const mtimeMs = Math.trunc(stats.mtimeMs);
  if (mtimeMs + FORMAL_EVIDENCE_OUTPUT_MTIME_TOLERANCE_MS < startedAtMs) {
    throwFormalEvidencePreparationError();
  }

  return {
    path: output.relativePath,
    size: stats.size,
    mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Seal the outputs produced by the wrapper's just-completed cleanup/build
 * phases. The random nonce and live wrapper PID make this an invocation-bound
 * handoff, while the exact output inventory prevents stale ignored artifacts
 * from being substituted after the build. A 24-hour post-build session window
 * avoids expiring healthy lock/build waits while still bounding PID-reuse risk.
 */
export function createFormalEvidencePreparationReceipt(
  env,
  repositoryRoot,
  {
    startedAtMs,
    viewBundleFiles,
    runnerPid = process.pid,
    receiptTempDirectory = tmpdir(),
  } = {},
) {
  const requestedEvidenceHead =
    env.ELIZA_PR_EVIDENCE_HEAD?.trim().toLowerCase();
  if (!requestedEvidenceHead) return null;
  if (
    !/^[a-f0-9]{40}$/.test(requestedEvidenceHead) ||
    !Number.isInteger(startedAtMs) ||
    startedAtMs <= 0 ||
    !Number.isInteger(runnerPid) ||
    runnerPid <= 0
  ) {
    throwFormalEvidencePreparationError();
  }

  let canonicalRepositoryRoot;
  let resolvedOutputs;
  try {
    canonicalRepositoryRoot = realpathSync.native(repositoryRoot);
    resolvedOutputs = resolveFormalEvidenceOutputFiles(
      canonicalRepositoryRoot,
      viewBundleFiles,
    );
  } catch {
    throwFormalEvidencePreparationError();
  }

  const completedAtMs = Date.now();
  if (!Number.isInteger(completedAtMs) || completedAtMs < startedAtMs) {
    throwFormalEvidencePreparationError();
  }
  const outputs = resolvedOutputs.map((output) =>
    fingerprintFormalEvidenceOutput(output, startedAtMs),
  );
  const nonce = randomBytes(32).toString("hex");

  let receiptDirectory;
  try {
    receiptDirectory = mkdtempSync(
      path.join(
        receiptTempDirectory,
        FORMAL_EVIDENCE_PREPARATION_RECEIPT_PREFIX,
      ),
    );
    const receiptPath = path.join(receiptDirectory, "preparation.json");
    writeFileSync(
      receiptPath,
      `${JSON.stringify({
        schema: FORMAL_EVIDENCE_PREPARATION_SCHEMA,
        nonce,
        repositoryRoot: canonicalRepositoryRoot,
        head: requestedEvidenceHead,
        runnerPid,
        startedAtMs,
        completedAtMs,
        outputs,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return { nonce, receiptDirectory, receiptPath };
  } catch {
    if (receiptDirectory) {
      try {
        rmSync(receiptDirectory, { force: true, recursive: true });
      } catch {
        // The original fail-closed error remains the useful diagnostic.
      }
    }
    throwFormalEvidencePreparationError();
  }
}

/**
 * Best-effort recovery for receipts left by SIGKILL, host shutdown, or a
 * default signal exit. Active wrapper receipts are preserved. Incomplete or
 * malformed directories get a short grace period so another wrapper cannot be
 * raced between mkdtemp and its atomic receipt write.
 */
export function cleanupAbandonedFormalEvidencePreparationReceipts({
  tempDirectory = tmpdir(),
  checkProcessAlive = isProcessAlive,
  currentTimeMs = Date.now(),
  invalidReceiptGraceMs = FORMAL_EVIDENCE_PREPARATION_INVALID_GRACE_MS,
} = {}) {
  let entries;
  try {
    entries = readdirSync(tempDirectory, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !entry.name.startsWith(FORMAL_EVIDENCE_PREPARATION_RECEIPT_PREFIX)
    ) {
      continue;
    }

    const receiptDirectory = path.join(tempDirectory, entry.name);
    let directoryStats;
    let receipt;
    try {
      directoryStats = lstatSync(receiptDirectory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        continue;
      }
      const receiptPath = path.join(receiptDirectory, "preparation.json");
      const receiptStats = lstatSync(receiptPath);
      if (!receiptStats.isFile() || receiptStats.isSymbolicLink()) {
        throw new Error("invalid receipt");
      }
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    } catch {
      receipt = null;
    }

    const hasValidLiveOwner =
      receipt?.schema === FORMAL_EVIDENCE_PREPARATION_SCHEMA &&
      Number.isInteger(receipt?.runnerPid) &&
      receipt.runnerPid > 0 &&
      Number.isInteger(receipt?.completedAtMs) &&
      receipt.completedAtMs <=
        currentTimeMs + FORMAL_EVIDENCE_PREPARATION_CLOCK_SKEW_MS &&
      currentTimeMs - receipt.completedAtMs <=
        FORMAL_EVIDENCE_PREPARATION_MAX_SESSION_AGE_MS &&
      checkProcessAlive(receipt.runnerPid);
    const invalidReceiptIsStale =
      receipt === null &&
      directoryStats &&
      Number.isFinite(directoryStats.mtimeMs) &&
      currentTimeMs - directoryStats.mtimeMs > invalidReceiptGraceMs;
    if (hasValidLiveOwner || (receipt === null && !invalidReceiptIsStale)) {
      continue;
    }

    try {
      rmSync(receiptDirectory, { force: true, recursive: true });
      removed += 1;
    } catch {
      // Startup recovery is best effort; formal validation still fails closed.
    }
  }
  return removed;
}

/**
 * Validate the wrapper handoff during config evaluation. Playwright creates
 * webServer tasks before globalSetup, so this guard intentionally runs at the
 * shared config boundary instead of in a later lifecycle hook.
 */
export function assertFormalEvidencePreparationReceipt(
  env,
  repositoryRoot,
  {
    checkProcessAlive = isProcessAlive,
    viewBundleFiles,
    currentTimeMs = Date.now(),
  } = {},
) {
  const requestedEvidenceHead =
    env.ELIZA_PR_EVIDENCE_HEAD?.trim().toLowerCase();
  if (!requestedEvidenceHead) return null;

  const receiptPath = env[FORMAL_EVIDENCE_PREPARATION_RECEIPT_ENV]?.trim();
  const expectedNonce = env[FORMAL_EVIDENCE_PREPARATION_NONCE_ENV]?.trim();
  if (
    !receiptPath ||
    !path.isAbsolute(receiptPath) ||
    !expectedNonce ||
    !/^[a-f0-9]{64}$/.test(expectedNonce)
  ) {
    throwFormalEvidencePreparationError();
  }

  let receipt;
  let canonicalRepositoryRoot;
  let expectedOutputs;
  try {
    const receiptStats = lstatSync(receiptPath);
    if (!receiptStats.isFile() || receiptStats.isSymbolicLink()) {
      throwFormalEvidencePreparationError();
    }
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    canonicalRepositoryRoot = realpathSync.native(repositoryRoot);
    expectedOutputs = resolveFormalEvidenceOutputFiles(
      canonicalRepositoryRoot,
      viewBundleFiles,
    );
  } catch {
    throwFormalEvidencePreparationError();
  }

  if (
    receipt?.schema !== FORMAL_EVIDENCE_PREPARATION_SCHEMA ||
    receipt?.nonce !== expectedNonce ||
    receipt?.repositoryRoot !== canonicalRepositoryRoot ||
    receipt?.head !== requestedEvidenceHead ||
    !Number.isInteger(receipt?.runnerPid) ||
    receipt.runnerPid <= 0 ||
    !checkProcessAlive(receipt.runnerPid) ||
    !Number.isInteger(receipt?.startedAtMs) ||
    receipt.startedAtMs <= 0 ||
    !Number.isInteger(receipt?.completedAtMs) ||
    receipt.completedAtMs < receipt.startedAtMs ||
    receipt.completedAtMs >
      currentTimeMs + FORMAL_EVIDENCE_PREPARATION_CLOCK_SKEW_MS ||
    currentTimeMs - receipt.completedAtMs >
      FORMAL_EVIDENCE_PREPARATION_MAX_SESSION_AGE_MS ||
    !Array.isArray(receipt?.outputs) ||
    receipt.outputs.length !== expectedOutputs.length
  ) {
    throwFormalEvidencePreparationError();
  }

  const currentOutputs = expectedOutputs.map((output) =>
    fingerprintFormalEvidenceOutput(output, receipt.startedAtMs),
  );
  if (JSON.stringify(currentOutputs) !== JSON.stringify(receipt.outputs)) {
    throwFormalEvidencePreparationError();
  }

  return {
    completedAtMs: receipt.completedAtMs,
    head: receipt.head,
    runnerPid: receipt.runnerPid,
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
