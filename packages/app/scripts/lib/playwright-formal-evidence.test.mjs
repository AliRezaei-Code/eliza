/**
 * Security regression for the environment matrix that controls Playwright
 * server reuse during ordinary UI smokes and formal exact-HEAD evidence runs.
 */

import { describe, expect, test } from "bun:test";
import {
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
