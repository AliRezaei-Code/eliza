/**
 * Security regression for the environment matrix that controls Playwright
 * server reuse during ordinary UI smokes and formal exact-HEAD evidence runs.
 */

import { describe, expect, test } from "bun:test";
import {
  assertFormalEvidenceRepositoryState,
  FORMAL_EVIDENCE_DIRTY_ERROR,
  FORMAL_EVIDENCE_HEAD_ERROR,
  FORMAL_EVIDENCE_REUSE_ERROR,
  resolveUiSmokeReuseExistingServer,
} from "./playwright-formal-evidence.mjs";

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
      ),
    ).toBe(head);
    expect(calls).toEqual([
      ["rev-parse", "HEAD"],
      ["status", "--porcelain=v1", "--untracked-files=normal"],
    ]);
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
