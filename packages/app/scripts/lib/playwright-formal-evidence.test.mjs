/**
 * Security regression for the environment matrix that controls Playwright
 * server reuse during ordinary UI smokes and formal exact-HEAD evidence runs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertFormalEvidenceRepositoryState,
  FORMAL_EVIDENCE_BUILD_SKIP_ERROR,
  FORMAL_EVIDENCE_CONFIG_AMBIGUITY_ERROR,
  FORMAL_EVIDENCE_CONFIG_ERROR,
  FORMAL_EVIDENCE_DIRTY_ERROR,
  FORMAL_EVIDENCE_HEAD_ERROR,
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
