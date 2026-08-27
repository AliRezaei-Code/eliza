/**
 * Security regression for the environment matrix that controls Playwright
 * server reuse during ordinary UI smokes and formal exact-HEAD evidence runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertFormalEvidencePreparationReceipt,
  assertFormalEvidenceRepositoryState,
  cleanupAbandonedFormalEvidencePreparationReceipts,
  createFormalEvidencePreparationReceipt,
  FORMAL_EVIDENCE_BUILD_SKIP_ERROR,
  FORMAL_EVIDENCE_CONFIG_AMBIGUITY_ERROR,
  FORMAL_EVIDENCE_CONFIG_ERROR,
  FORMAL_EVIDENCE_DIRTY_ERROR,
  FORMAL_EVIDENCE_HEAD_ERROR,
  FORMAL_EVIDENCE_PREPARATION_ERROR,
  FORMAL_EVIDENCE_PREPARATION_NONCE_ENV,
  FORMAL_EVIDENCE_PREPARATION_RECEIPT_ENV,
  FORMAL_EVIDENCE_REUSE_ERROR,
  FORMAL_EVIDENCE_VITE_ENV_ERROR,
  PLAYWRIGHT_CONFIG_ARGUMENT_ERROR,
  resolveFormalEvidencePlaywrightConfig,
  resolveLinkedRendererBuildPlan,
  resolvePlaywrightConfigArgument,
  resolveUiSmokeReuseExistingServer,
} from "./playwright-formal-evidence.mjs";

describe("resolvePlaywrightConfigArgument", () => {
  const config = "playwright.ui-smoke.config.ts";

  test.each([
    ["split long", ["--config", config]],
    ["split short", ["-c", config]],
    ["long equals", [`--config=${config}`]],
    ["attached short", [`-c${config}`]],
  ])("recognizes the %s form", (_name, args) => {
    expect(resolvePlaywrightConfigArgument(args)).toBe(config);
  });

  test("does not misread an unrelated long option beginning with c", () => {
    expect(resolvePlaywrightConfigArgument(["--color", "always"])).toBeNull();
  });

  test("stops option parsing at the positional separator", () => {
    expect(
      resolvePlaywrightConfigArgument(["--", "--config", config]),
    ).toBeNull();
  });

  test("uses Playwright's last-declaration-wins behavior outside formal mode", () => {
    expect(
      resolvePlaywrightConfigArgument([
        "--config",
        "playwright.dev-smoke.config.ts",
        `--config=${config}`,
      ]),
    ).toBe(config);
  });

  test.each([
    ["split long", ["--config"]],
    ["split short", ["-c"]],
    ["long equals", ["--config="]],
  ])("rejects a missing value in %s", (_name, args) => {
    expect(() => resolvePlaywrightConfigArgument(args)).toThrow(
      PLAYWRIGHT_CONFIG_ARGUMENT_ERROR,
    );
  });
});

describe("resolveFormalEvidencePlaywrightConfig", () => {
  const head = "a".repeat(40);
  const appDirectory = "/repo/packages/app";
  const canonicalConfig = `${appDirectory}/playwright.ui-smoke.config.ts`;
  const existingCanonicalPath = (filePath) => {
    if (filePath === canonicalConfig) return filePath;
    throw new Error(`missing: ${filePath}`);
  };

  test.each([
    ["split long", ["--config", "playwright.ui-smoke.config.ts"]],
    ["split short", ["-c", "playwright.ui-smoke.config.ts"]],
    ["long equals", ["--config=playwright.ui-smoke.config.ts"]],
    ["attached short", ["-cplaywright.ui-smoke.config.ts"]],
  ])(
    "keeps formal UI-smoke cleanup and build gates enabled for %s",
    (_name, args) => {
      expect(
        resolveFormalEvidencePlaywrightConfig(
          { ELIZA_PR_EVIDENCE_HEAD: head },
          args,
          appDirectory,
          existingCanonicalPath,
        ),
      ).toBe("playwright.ui-smoke.config.ts");
    },
  );

  test("rejects formal evidence without a selected config", () => {
    expect(() =>
      resolveFormalEvidencePlaywrightConfig(
        { ELIZA_PR_EVIDENCE_HEAD: head },
        [],
        appDirectory,
        existingCanonicalPath,
      ),
    ).toThrow(FORMAL_EVIDENCE_CONFIG_ERROR);
  });

  test("rejects a missing formal config path", () => {
    expect(() =>
      resolveFormalEvidencePlaywrightConfig(
        { ELIZA_PR_EVIDENCE_HEAD: head },
        ["--config=missing.config.ts"],
        appDirectory,
        existingCanonicalPath,
      ),
    ).toThrow(FORMAL_EVIDENCE_CONFIG_ERROR);
  });

  test("rejects an existing non-UI-smoke formal config", () => {
    expect(() =>
      resolveFormalEvidencePlaywrightConfig(
        { ELIZA_PR_EVIDENCE_HEAD: head },
        ["-c", "playwright.dev-smoke.config.ts"],
        appDirectory,
        (filePath) => filePath,
      ),
    ).toThrow(FORMAL_EVIDENCE_CONFIG_ERROR);
  });

  test("rejects multiple formal config declarations", () => {
    expect(() =>
      resolveFormalEvidencePlaywrightConfig(
        { ELIZA_PR_EVIDENCE_HEAD: head },
        [
          "--config=playwright.dev-smoke.config.ts",
          "-c",
          "playwright.ui-smoke.config.ts",
        ],
        appDirectory,
        existingCanonicalPath,
      ),
    ).toThrow(FORMAL_EVIDENCE_CONFIG_AMBIGUITY_ERROR);
  });

  test("preserves Playwright config selection outside formal mode", () => {
    let realpathCalls = 0;
    expect(
      resolveFormalEvidencePlaywrightConfig(
        {},
        ["--config=missing.config.ts"],
        appDirectory,
        () => {
          realpathCalls += 1;
          throw new Error("must stay lazy");
        },
      ),
    ).toBe("missing.config.ts");
    expect(realpathCalls).toBe(0);
  });
});

describe("resolveLinkedRendererBuildPlan", () => {
  const repositoryRoot = path.resolve("/repo");
  const baseTurboArgs = [
    path.join(repositoryRoot, "packages", "scripts", "run-turbo.mjs"),
    "run",
    "build",
    "--filter=@elizaos/shared",
    "--filter=@elizaos/core",
  ];

  test("keeps ordinary UI smokes non-destructive and cacheable", () => {
    expect(resolveLinkedRendererBuildPlan(repositoryRoot)).toEqual({
      cleanupOutputDirs: [],
      turboArgs: baseTurboArgs,
    });
  });

  test("returns only fixed cleanup targets and formal-only forced Turbo args", () => {
    expect(
      resolveLinkedRendererBuildPlan(repositoryRoot, {
        formalEvidenceValidated: true,
      }),
    ).toEqual({
      cleanupOutputDirs: [
        path.join(repositoryRoot, "packages", "shared", "dist"),
        path.join(repositoryRoot, "packages", "core", "dist"),
      ],
      turboArgs: [...baseTurboArgs, "--force"],
    });
  });
});

describe("run-ui-playwright formal wiring invariant", () => {
  const runnerSource = readFileSync(
    new URL("../run-ui-playwright.mjs", import.meta.url),
    "utf8",
  );

  function markerIndex(marker) {
    const index = runnerSource.indexOf(marker);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  }

  test("runs every formal guard and resolves the plan before cleanup or build", () => {
    const configGuard = markerIndex(
      "const selectedPlaywrightConfig = resolveFormalEvidencePlaywrightConfig(",
    );
    const repositoryGuard = markerIndex(
      "assertFormalEvidenceRepositoryState(env, repoRoot);",
    );
    const reuseGuard = markerIndex("resolveUiSmokeReuseExistingServer(env);");
    const validatedMode = markerIndex(
      "const formalEvidenceValidated = Boolean(",
    );
    const buildPlan = markerIndex(
      "const linkedRendererBuildPlan = resolveLinkedRendererBuildPlan(",
    );
    const firstCleanupOrBuild = Math.min(
      markerIndex("releaseUiSmokeViewLock = acquireUiSmokeViewLock();"),
      markerIndex("cleanAuditAppOutput();"),
      markerIndex(
        'path.join(repoRoot, "packages", "scripts", "build-views.mjs")',
      ),
    );

    expect(runnerSource).toContain(
      "const formalEvidenceValidated = Boolean(env.ELIZA_PR_EVIDENCE_HEAD?.trim());",
    );
    expect(configGuard).toBeLessThan(repositoryGuard);
    expect(repositoryGuard).toBeLessThan(reuseGuard);
    expect(reuseGuard).toBeLessThan(validatedMode);
    expect(validatedMode).toBeLessThan(buildPlan);
    expect(buildPlan).toBeLessThan(firstCleanupOrBuild);
  });

  test("uses the pure plan for both cleanup targets and Turbo arguments", () => {
    expect(runnerSource).toContain(
      "for (const outputDir of linkedRendererBuildPlan.cleanupOutputDirs)",
    );
    expect(runnerSource).toContain(
      'removePathRecursive(outputDir, "formal linked renderer build output");',
    );
    expect(runnerSource).toContain("linkedRendererBuildPlan.turboArgs,");
    expect(runnerSource).not.toContain(
      'path.join(repoRoot, "packages", "shared", "dist")',
    );
    expect(runnerSource).not.toContain(
      'path.join(repoRoot, "packages", "core", "dist")',
    );
    expect(runnerSource).not.toContain('"--force"');
  });

  test("replaces inherited handoffs and creates one only after both builds", () => {
    const clearReceipt = markerIndex(
      "delete env[FORMAL_EVIDENCE_PREPARATION_RECEIPT_ENV];",
    );
    const configGuard = markerIndex(
      "const selectedPlaywrightConfig = resolveFormalEvidencePlaywrightConfig(",
    );
    const viewComplete = markerIndex(
      "formalEvidenceViewBuildCompleted = formalEvidenceValidated;",
    );
    const linkedComplete = markerIndex(
      "formalEvidenceLinkedBuildCompleted = formalEvidenceValidated;",
    );
    const createReceipt = markerIndex(
      "const receipt = createFormalEvidencePreparationReceipt(env, repoRoot, {",
    );
    const spawnPlaywright = markerIndex(
      "const child = spawn(playwrightCommand,",
    );

    expect(clearReceipt).toBeLessThan(configGuard);
    expect(viewComplete).toBeLessThan(createReceipt);
    expect(linkedComplete).toBeLessThan(createReceipt);
    expect(createReceipt).toBeLessThan(spawnPlaywright);
    expect(runnerSource).toContain(
      "env[FORMAL_EVIDENCE_PREPARATION_RECEIPT_ENV] = receipt.receiptPath;",
    );
    expect(runnerSource).toContain(
      "env[FORMAL_EVIDENCE_PREPARATION_NONCE_ENV] = receipt.nonce;",
    );
  });

  test("starts preparation after lock ownership and recovers abandoned receipts", () => {
    const auditLockAcquired = markerIndex(
      "releaseUiSmokeViewLock = acquireUiSmokeViewLock();",
    );
    const auditPreparationStart = runnerSource.indexOf(
      "formalEvidencePreparationStartedAtMs = Date.now();",
      auditLockAcquired,
    );
    const fallbackLockAcquired = markerIndex(
      "releaseUiSmokeViewLock ??= acquireUiSmokeViewLock();",
    );
    const fallbackPreparationStart = runnerSource.indexOf(
      "formalEvidencePreparationStartedAtMs = Date.now();",
      fallbackLockAcquired,
    );
    const receiptCreation = markerIndex(
      "const receipt = createFormalEvidencePreparationReceipt(env, repoRoot, {",
    );
    const abandonedReceiptCleanup = markerIndex(
      "cleanupAbandonedFormalEvidencePreparationReceipts();",
    );

    expect(auditPreparationStart).toBeGreaterThan(auditLockAcquired);
    expect(fallbackPreparationStart).toBeGreaterThan(fallbackLockAcquired);
    expect(auditPreparationStart).toBeLessThan(receiptCreation);
    expect(fallbackPreparationStart).toBeLessThan(receiptCreation);
    expect(abandonedReceiptCleanup).toBeLessThan(receiptCreation);
    expect(runnerSource).not.toContain('process.once("SIGINT"');
    expect(runnerSource).not.toContain('process.once("SIGTERM"');
  });
});

describe("formal evidence preparation handoff", () => {
  const head = "a".repeat(40);
  const temporaryDirectories = [];

  afterEach(() => {
    for (const directoryPath of temporaryDirectories.splice(0)) {
      rmSync(directoryPath, { force: true, recursive: true });
    }
  });

  function makeOutputTree() {
    const repositoryRoot = realpathSync.native(
      mkdtempSync(path.join(tmpdir(), "formal-evidence-repo-")),
    );
    temporaryDirectories.push(repositoryRoot);
    const startedAtMs = Date.now() - 500;
    const files = {
      coreEntry: path.join(repositoryRoot, "packages/core/dist/index.js"),
      coreNested: path.join(
        repositoryRoot,
        "packages/core/dist/browser/chunk.js",
      ),
      sharedEntry: path.join(repositoryRoot, "packages/shared/dist/index.js"),
      sharedNested: path.join(
        repositoryRoot,
        "packages/shared/dist/internal/chunk.js",
      ),
      viewBundle: path.join(
        repositoryRoot,
        "packages/plugin-example/dist/views/bundle.js",
      ),
    };
    for (const [name, filePath] of Object.entries(files)) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${name} fresh output`);
    }
    return {
      files,
      repositoryRoot,
      startedAtMs,
      viewBundleFiles: [files.viewBundle],
    };
  }

  function makeFixture() {
    const outputTree = makeOutputTree();
    const env = { ELIZA_PR_EVIDENCE_HEAD: head };
    const receipt = createFormalEvidencePreparationReceipt(
      env,
      outputTree.repositoryRoot,
      {
        startedAtMs: outputTree.startedAtMs,
        viewBundleFiles: outputTree.viewBundleFiles,
      },
    );
    temporaryDirectories.push(receipt.receiptDirectory);
    env[FORMAL_EVIDENCE_PREPARATION_RECEIPT_ENV] = receipt.receiptPath;
    env[FORMAL_EVIDENCE_PREPARATION_NONCE_ENV] = receipt.nonce;
    return { ...outputTree, env, receipt };
  }

  function validateFixture(fixture, options = {}) {
    return assertFormalEvidencePreparationReceipt(
      fixture.env,
      fixture.repositoryRoot,
      { viewBundleFiles: fixture.viewBundleFiles, ...options },
    );
  }

  test("rejects a direct Playwright config entry without a wrapper receipt", () => {
    const repositoryRoot = mkdtempSync(
      path.join(tmpdir(), "formal-evidence-direct-"),
    );
    temporaryDirectories.push(repositoryRoot);

    expect(() =>
      assertFormalEvidencePreparationReceipt(
        {
          ELIZA_PR_EVIDENCE_HEAD: head,
          ELIZA_PR_EVIDENCE_PREPARED: "1",
        },
        repositoryRoot,
      ),
    ).toThrow(FORMAL_EVIDENCE_PREPARATION_ERROR);
  });

  test("accepts an exact, live, unchanged wrapper handoff", () => {
    const fixture = makeFixture();
    expect(validateFixture(fixture)).toMatchObject({
      head,
      runnerPid: process.pid,
    });
  });

  test("allows a healthy long-running formal session", () => {
    const fixture = makeFixture();
    expect(
      validateFixture(fixture, {
        currentTimeMs: Date.now() + 12 * 60 * 60 * 1_000,
      }),
    ).toMatchObject({ head, runnerPid: process.pid });
  });

  test("bounds PID-reuse risk after the formal session window", () => {
    const fixture = makeFixture();
    const receipt = JSON.parse(
      readFileSync(fixture.receipt.receiptPath, "utf8"),
    );
    receipt.startedAtMs -= 25 * 60 * 60 * 1_000;
    receipt.completedAtMs -= 25 * 60 * 60 * 1_000;
    writeFileSync(fixture.receipt.receiptPath, `${JSON.stringify(receipt)}\n`);

    expect(() => validateFixture(fixture)).toThrow(
      FORMAL_EVIDENCE_PREPARATION_ERROR,
    );
  });

  test("purges dead and stale-incomplete receipts without touching live ones", () => {
    const cleanupRoot = mkdtempSync(
      path.join(tmpdir(), "formal-evidence-cleanup-"),
    );
    temporaryDirectories.push(cleanupRoot);
    const outputTree = makeOutputTree();
    const liveReceipt = createFormalEvidencePreparationReceipt(
      { ELIZA_PR_EVIDENCE_HEAD: head },
      outputTree.repositoryRoot,
      {
        startedAtMs: outputTree.startedAtMs,
        viewBundleFiles: outputTree.viewBundleFiles,
        receiptTempDirectory: cleanupRoot,
      },
    );
    const deadReceipt = createFormalEvidencePreparationReceipt(
      { ELIZA_PR_EVIDENCE_HEAD: head },
      outputTree.repositoryRoot,
      {
        startedAtMs: outputTree.startedAtMs,
        viewBundleFiles: outputTree.viewBundleFiles,
        runnerPid: process.pid + 1_000_000,
        receiptTempDirectory: cleanupRoot,
      },
    );
    const incompleteReceipt = path.join(
      cleanupRoot,
      "eliza-formal-evidence-incomplete",
    );
    mkdirSync(incompleteReceipt);
    utimesSync(incompleteReceipt, new Date(0), new Date(0));
    const recentIncompleteReceipt = path.join(
      cleanupRoot,
      "eliza-formal-evidence-recent-incomplete",
    );
    mkdirSync(recentIncompleteReceipt);

    const removed = cleanupAbandonedFormalEvidencePreparationReceipts({
      tempDirectory: cleanupRoot,
      checkProcessAlive: (pid) => pid === process.pid,
      currentTimeMs: Date.now(),
    });

    expect(removed).toBe(2);
    expect(existsSync(liveReceipt.receiptDirectory)).toBe(true);
    expect(existsSync(deadReceipt.receiptDirectory)).toBe(false);
    expect(existsSync(incompleteReceipt)).toBe(false);
    expect(existsSync(recentIncompleteReceipt)).toBe(true);
  });

  test("rejects a receipt whose wrapper process is no longer live", () => {
    const fixture = makeFixture();
    expect(() =>
      validateFixture(fixture, { checkProcessAlive: () => false }),
    ).toThrow(FORMAL_EVIDENCE_PREPARATION_ERROR);
  });

  test("rejects mutation of a non-entry shared output after sealing", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.files.sharedNested, "stale substitution");
    expect(() => validateFixture(fixture)).toThrow(
      FORMAL_EVIDENCE_PREPARATION_ERROR,
    );
  });

  test("seals the complete recursive linked inventory and detects additions", () => {
    const fixture = makeFixture();
    const receipt = JSON.parse(
      readFileSync(fixture.receipt.receiptPath, "utf8"),
    );
    expect(receipt.outputs.map((output) => output.path)).toEqual([
      "packages/core/dist/browser/chunk.js",
      "packages/core/dist/index.js",
      "packages/plugin-example/dist/views/bundle.js",
      "packages/shared/dist/index.js",
      "packages/shared/dist/internal/chunk.js",
    ]);

    const addedOutput = path.join(
      fixture.repositoryRoot,
      "packages/shared/dist/internal/later.js",
    );
    writeFileSync(addedOutput, "not present when sealed");
    expect(() => validateFixture(fixture)).toThrow(
      FORMAL_EVIDENCE_PREPARATION_ERROR,
    );
  });

  test("refuses to seal an ignored output older than this invocation", () => {
    const fixture = makeOutputTree();
    utimesSync(fixture.files.sharedNested, new Date(0), new Date(0));

    expect(() =>
      createFormalEvidencePreparationReceipt(
        { ELIZA_PR_EVIDENCE_HEAD: head },
        fixture.repositoryRoot,
        {
          startedAtMs: Date.now(),
          viewBundleFiles: fixture.viewBundleFiles,
        },
      ),
    ).toThrow(FORMAL_EVIDENCE_PREPARATION_ERROR);
  });

  test.each(["file", "directory"])(
    "rejects a symlinked %s inside a linked dist",
    (kind) => {
      const fixture = makeOutputTree();
      const linkPath = path.join(
        fixture.repositoryRoot,
        `packages/shared/dist/${kind}-link`,
      );
      const target =
        kind === "file"
          ? fixture.files.sharedNested
          : path.dirname(fixture.files.sharedNested);
      symlinkSync(target, linkPath, kind === "directory" ? "dir" : "file");

      expect(() =>
        createFormalEvidencePreparationReceipt(
          { ELIZA_PR_EVIDENCE_HEAD: head },
          fixture.repositoryRoot,
          {
            startedAtMs: fixture.startedAtMs,
            viewBundleFiles: fixture.viewBundleFiles,
          },
        ),
      ).toThrow(FORMAL_EVIDENCE_PREPARATION_ERROR);
    },
  );

  test.each(["missing", "empty"])(
    "rejects a linked dist root when %s",
    (kind) => {
      const fixture = makeOutputTree();
      const coreDist = path.join(fixture.repositoryRoot, "packages/core/dist");
      rmSync(coreDist, { force: true, recursive: true });
      if (kind === "empty") mkdirSync(coreDist, { recursive: true });

      expect(() =>
        createFormalEvidencePreparationReceipt(
          { ELIZA_PR_EVIDENCE_HEAD: head },
          fixture.repositoryRoot,
          {
            startedAtMs: fixture.startedAtMs,
            viewBundleFiles: fixture.viewBundleFiles,
          },
        ),
      ).toThrow(FORMAL_EVIDENCE_PREPARATION_ERROR);
    },
  );

  test("rejects duplicate or repository-escaping view paths without leaking them", () => {
    const fixture = makeOutputTree();
    const externalRoot = mkdtempSync(
      path.join(tmpdir(), "formal-evidence-external-"),
    );
    temporaryDirectories.push(externalRoot);
    const externalFile = path.join(externalRoot, "secret-path.js");
    writeFileSync(externalFile, "outside repository");

    for (const viewBundleFiles of [
      [fixture.files.viewBundle, fixture.files.viewBundle],
      [externalFile],
    ]) {
      let thrown;
      try {
        createFormalEvidencePreparationReceipt(
          { ELIZA_PR_EVIDENCE_HEAD: head },
          fixture.repositoryRoot,
          { startedAtMs: fixture.startedAtMs, viewBundleFiles },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.message).toBe(FORMAL_EVIDENCE_PREPARATION_ERROR);
      expect(thrown?.message).not.toContain(externalFile);
    }
  });

  test("is inert outside formal evidence mode", () => {
    expect(
      createFormalEvidencePreparationReceipt({}, "/missing", {
        startedAtMs: Date.now(),
      }),
    ).toBeNull();
    expect(assertFormalEvidencePreparationReceipt({}, "/missing")).toBeNull();
  });

  test("binds the handoff to its nonce and exact evidence head", () => {
    const fixture = makeFixture();
    const wrongNonceEnv = {
      ...fixture.env,
      [FORMAL_EVIDENCE_PREPARATION_NONCE_ENV]: "b".repeat(64),
    };
    const wrongHeadEnv = {
      ...fixture.env,
      ELIZA_PR_EVIDENCE_HEAD: "b".repeat(40),
    };

    expect(() =>
      assertFormalEvidencePreparationReceipt(
        wrongNonceEnv,
        fixture.repositoryRoot,
        {
          viewBundleFiles: fixture.viewBundleFiles,
        },
      ),
    ).toThrow(FORMAL_EVIDENCE_PREPARATION_ERROR);
    expect(() =>
      assertFormalEvidencePreparationReceipt(
        wrongHeadEnv,
        fixture.repositoryRoot,
        {
          viewBundleFiles: fixture.viewBundleFiles,
        },
      ),
    ).toThrow(FORMAL_EVIDENCE_PREPARATION_ERROR);
  });
});

describe("playwright config formal-entry invariant", () => {
  const configSource = readFileSync(
    new URL("../../playwright.ui-smoke.config.ts", import.meta.url),
    "utf8",
  );
  const hostedSigninSource = readFileSync(
    new URL(
      "../../test/ui-smoke/hosted-signin-wallet-capability.spec.ts",
      import.meta.url,
    ),
    "utf8",
  );

  test("validates the wrapper handoff before reuse and webServer wiring", () => {
    const repositoryGuard = configSource.indexOf(
      "assertFormalEvidenceRepositoryState(process.env, repoRoot);",
    );
    const preparationGuard = configSource.indexOf(
      "assertFormalEvidencePreparationReceipt(process.env, repoRoot);",
    );
    const reuseGuard = configSource.indexOf(
      "resolveUiSmokeReuseExistingServer(process.env)",
    );
    const configExport = configSource.indexOf("export default defineConfig(");

    expect(repositoryGuard).toBeGreaterThanOrEqual(0);
    expect(preparationGuard).toBeGreaterThan(repositoryGuard);
    expect(reuseGuard).toBeGreaterThan(preparationGuard);
    expect(configExport).toBeGreaterThan(reuseGuard);
  });

  test("guards hosted evidence before reading its head or tagging artifacts", () => {
    const preparationGuard = hostedSigninSource.indexOf(
      "assertFormalEvidencePreparationReceipt(process.env, REPO_ROOT);",
    );
    const evidenceHeadRead = hostedSigninSource.indexOf(
      "const requestedEvidenceHead =",
    );
    const revisionTag = hostedSigninSource.indexOf("const EVIDENCE_REVISION =");
    const formalModeArtifactTag = hostedSigninSource.indexOf(
      "assertion:formal-evidence-mode=",
    );

    expect(preparationGuard).toBeGreaterThanOrEqual(0);
    expect(evidenceHeadRead).toBeGreaterThan(preparationGuard);
    expect(revisionTag).toBeGreaterThan(preparationGuard);
    expect(formalModeArtifactTag).toBeGreaterThan(preparationGuard);
  });
});

describe("resolveUiSmokeReuseExistingServer", () => {
  test.each([
    [{}, false],
    [{ ELIZA_UI_SMOKE_REUSE_SERVER: "0" }, false],
    [{ ELIZA_UI_SMOKE_REUSE_SERVER: "1" }, true],
    [{ ELIZA_PR_EVIDENCE_HEAD: "a".repeat(40) }, false],
    [
      {
        ELIZA_PR_EVIDENCE_HEAD: "a".repeat(40),
        ELIZA_UI_SMOKE_REUSE_SERVER: "0",
      },
      false,
    ],
    [
      {
        ELIZA_PR_EVIDENCE_HEAD: "   ",
        ELIZA_UI_SMOKE_REUSE_SERVER: "1",
      },
      true,
    ],
  ])("resolves %o to %s", (env, expected) => {
    expect(resolveUiSmokeReuseExistingServer(env)).toBe(expected);
  });

  test("rejects reuse whenever a formal evidence head is present", () => {
    expect(() =>
      resolveUiSmokeReuseExistingServer({
        ELIZA_PR_EVIDENCE_HEAD: "a".repeat(40),
        ELIZA_UI_SMOKE_REUSE_SERVER: "1",
      }),
    ).toThrow(FORMAL_EVIDENCE_REUSE_ERROR);
  });
});

describe("assertFormalEvidenceRepositoryState", () => {
  const head = "a".repeat(40);

  test("is inert outside formal evidence mode", () => {
    let calls = 0;
    expect(
      assertFormalEvidenceRepositoryState({}, "/repo", () => {
        calls += 1;
        return "";
      }),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  test("accepts exact clean HEAD before server startup", () => {
    const calls = [];
    expect(
      assertFormalEvidenceRepositoryState(
        { ELIZA_PR_EVIDENCE_HEAD: head.toUpperCase() },
        "/repo",
        (args) => {
          calls.push(args);
          return args[0] === "rev-parse" ? `${head}\n` : "";
        },
        () => [],
      ),
    ).toBe(head);
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["status", "--porcelain=v1", "--untracked-files=normal"],
    ]);
  });

  test.each([
    "ELIZA_UI_SMOKE_SKIP_BUILD",
    "ELIZA_UI_SMOKE_SKIP_VIEW_BUILD",
    "ELIZA_UI_SMOKE_SKIP_CORE_BUILD",
  ])("rejects formal evidence when %s enables a prebuilt input", (name) => {
    let gitCalls = 0;
    expect(() =>
      assertFormalEvidenceRepositoryState(
        {
          ELIZA_PR_EVIDENCE_HEAD: head,
          [name]: "1",
        },
        "/repo",
        () => {
          gitCalls += 1;
          return "";
        },
        () => [],
      ),
    ).toThrow(FORMAL_EVIDENCE_BUILD_SKIP_ERROR);
    expect(gitCalls).toBe(0);
  });

  test("allows disabled build-skip inputs in formal evidence mode", () => {
    expect(
      assertFormalEvidenceRepositoryState(
        {
          ELIZA_PR_EVIDENCE_HEAD: head,
          ELIZA_UI_SMOKE_SKIP_BUILD: "0",
          ELIZA_UI_SMOKE_SKIP_VIEW_BUILD: "0",
          ELIZA_UI_SMOKE_SKIP_CORE_BUILD: "0",
        },
        "/repo",
        (args) => (args[0] === "rev-parse" ? head : ""),
        () => [],
      ),
    ).toBe(head);
  });

  test.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".ENV.PRODUCTION.LOCAL",
  ])(
    "rejects filesystem-visible Vite production input %s even when git status omits it",
    (localEnvFile) => {
      expect(() =>
        assertFormalEvidenceRepositoryState(
          { ELIZA_PR_EVIDENCE_HEAD: head },
          "/repo",
          (args) => (args[0] === "rev-parse" ? head : ""),
          () => [".env.example", localEnvFile],
        ),
      ).toThrow(FORMAL_EVIDENCE_VITE_ENV_ERROR);
    },
  );

  test("does not reject the committed non-input .env.example template", () => {
    expect(
      assertFormalEvidenceRepositoryState(
        { ELIZA_PR_EVIDENCE_HEAD: head },
        "/repo",
        (args) => (args[0] === "rev-parse" ? head : ""),
        () => [".env.example"],
      ),
    ).toBe(head);
  });

  test.each([
    ["short requested SHA", "abc", head, "", FORMAL_EVIDENCE_HEAD_ERROR],
    [
      "mismatched checked-out HEAD",
      head,
      "b".repeat(40),
      "",
      FORMAL_EVIDENCE_HEAD_ERROR,
    ],
    [
      "dirty tracked source",
      head,
      head,
      " M packages/app/source.ts\n",
      FORMAL_EVIDENCE_DIRTY_ERROR,
    ],
    [
      "untracked source",
      head,
      head,
      "?? packages/app/new-source.ts\n",
      FORMAL_EVIDENCE_DIRTY_ERROR,
    ],
  ])("rejects %s", (_name, requested, actual, status, expectedError) => {
    expect(() =>
      assertFormalEvidenceRepositoryState(
        { ELIZA_PR_EVIDENCE_HEAD: requested },
        "/repo",
        (args) => (args[0] === "rev-parse" ? actual : status),
      ),
    ).toThrow(expectedError);
  });
});
