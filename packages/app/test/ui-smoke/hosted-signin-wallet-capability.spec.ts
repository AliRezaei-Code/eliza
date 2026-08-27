/**
 * Real-browser regression and PR evidence for the hosted sign-in wallet
 * capability boundary. The lightweight disclosure and the lazy wallet stack
 * must both obey the same provider discovery response.
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

test.use({
  screenshot: "off",
  trace: "off",
  video: { mode: "on", size: { width: 1440, height: 900 } },
});

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function gitOutput(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const repositoryHead = gitOutput(["rev-parse", "HEAD"]).toLowerCase();
if (!/^[a-f0-9]{40}$/.test(repositoryHead)) {
  throw new Error(
    "Could not resolve a full repository HEAD for renderer proof",
  );
}

const requestedEvidenceHead =
  process.env.ELIZA_PR_EVIDENCE_HEAD?.trim().toLowerCase();
if (requestedEvidenceHead && !/^[a-f0-9]{40}$/i.test(requestedEvidenceHead)) {
  throw new Error("ELIZA_PR_EVIDENCE_HEAD must be a full commit SHA");
}
if (requestedEvidenceHead && requestedEvidenceHead !== repositoryHead) {
  throw new Error(
    `ELIZA_PR_EVIDENCE_HEAD ${requestedEvidenceHead} does not match checked-out HEAD ${repositoryHead}`,
  );
}
if (
  requestedEvidenceHead &&
  gitOutput(["status", "--porcelain=v1", "--untracked-files=normal"]).length > 0
) {
  throw new Error(
    "Formal PR evidence requires a clean worktree at ELIZA_PR_EVIDENCE_HEAD",
  );
}
const EVIDENCE_REVISION = repositoryHead.slice(0, 12);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const SIWE_ONLY_PROVIDERS = {
  passkey: false,
  email: true,
  sms: false,
  siwe: true,
  siws: false,
  google: true,
  discord: true,
  github: true,
  twitter: false,
  telegram: false,
  oauth: [],
};

function isCanonicalProviderDiscovery(
  method: string,
  pathname: string,
): boolean {
  return method === "GET" && pathname === "/steward/auth/providers";
}

function isAuthSurface(pathname: string): boolean {
  return (
    /\/auth(?:\/|$)/i.test(pathname) ||
    /^\/api\/cloud\/login(?:\/|$)/i.test(pathname)
  );
}

function isForbiddenHttpAuthRequest(method: string, pathname: string): boolean {
  return (
    isAuthSurface(pathname) && !isCanonicalProviderDiscovery(method, pathname)
  );
}

async function installProviderFixture(context: BrowserContext): Promise<void> {
  // Keep the provider-backed intent pending after the lazy boundary. The test
  // proves capability rendering, not an account authorization, and must not
  // open a real wallet or paint a synthetic connection failure into evidence.
  await context.addInitScript(() => {
    const methods: string[] = [];
    Object.defineProperty(window, "__elizaWalletCapabilityMethods", {
      configurable: true,
      value: methods,
    });
    const ethereum = {
      request: ({ method }: { method: string }) => {
        methods.push(method);
        if (method === "eth_accounts") {
          return new Promise<readonly string[]>(() => {});
        }
        return Promise.reject(new Error(`Unexpected wallet method: ${method}`));
      },
    };
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: ethereum,
    });
  });
  // This catch-all is installed before navigation, so unexpected wallet RPC,
  // WalletConnect, OAuth, or provider traffic is aborted before network egress
  // instead of merely being noticed after transmission.
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const pathname = parseUrl(requestUrl)?.pathname ?? "";
    if (!isLoopbackOrLocalResource(requestUrl)) {
      await route.abort("blockedbyclient");
      return;
    }
    if (isCanonicalProviderDiscovery(route.request().method(), pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SIWE_ONLY_PROVIDERS),
      });
      return;
    }
    if (isForbiddenHttpAuthRequest(route.request().method(), pathname)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function safeResourceLabel(rawUrl: string): string {
  const url = parseUrl(rawUrl);
  if (!url) return "[unparseable-url]";
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return `[${url.protocol.slice(0, -1)}-url]`;
  }
  if (!isLoopbackOrLocalResource(rawUrl)) return "[external-origin]";
  if (url.pathname === "/login") return "[login-route]";
  if (url.pathname === "/eliza-renderer-build.json") {
    return "[renderer-manifest]";
  }
  if (url.pathname === "/steward/auth/providers") {
    return "[provider-discovery]";
  }
  if (
    url.pathname.includes("/assets/wallet-buttons-") ||
    url.pathname.includes("/assets/steward-wallet-providers-")
  ) {
    return "[wallet-chunk]";
  }
  if (url.pathname.startsWith("/assets/")) return "[local-asset]";
  // Unknown loopback paths can still contain callback codes, session ids, or
  // other credentials. Keep them useful only as a resource class.
  return "[local-resource]";
}

function isLoopbackOrLocalResource(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  return (
    (url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ws:" ||
      url.protocol === "wss:") &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]")
  );
}

function classifyConsoleMessage(type: string, rawText: string): string {
  if (rawText === "Service Worker registration blocked by Playwright") {
    return `console:${type}:expected-service-worker-block`;
  }
  if (/^\[renderer-build\] [a-f0-9]{12} built /i.test(rawText)) {
    return `console:${type}:renderer-build-marker-observed`;
  }
  // Do not persist arbitrary renderer text: a future regression could include
  // a token, account, callback URL, or provider response in a console message.
  return `console:${type}:[redacted-${rawText.length}-character-message]`;
}

function classifyRequestFailure(rawText: string | undefined): string {
  if (rawText && /^net::[A-Z0-9_]+$/i.test(rawText)) return rawText;
  return "[redacted-request-failure]";
}

async function assertExactEvidenceRenderer(page: Page): Promise<boolean> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stamp = Reflect.get(window, "__ELIZA_RENDERER_BUILD__");
          if (stamp === null || typeof stamp !== "object") return null;
          const commit = Reflect.get(stamp, "commit");
          return typeof commit === "string" ? commit : null;
        }),
      {
        message:
          "the rendered bundle must be stamped with checked-out repository HEAD",
        timeout: 15_000,
      },
    )
    .toBe(repositoryHead);
  return true;
}

for (const viewport of VIEWPORTS) {
  test(`lazy wallet stack preserves SIWE-only discovery at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const context = page.context();

    const frontendEvents: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const nonLoopbackRequests: string[] = [];
    const nonLoopbackWebSockets: string[] = [];
    const forbiddenAuthWebSockets: string[] = [];
    const unexpectedPages: string[] = [];
    const forbiddenAuthRequests: string[] = [];
    const consoleErrors: string[] = [];
    const httpErrors: string[] = [];
    let providerDiscoveryResponses = 0;
    let walletChunkRequests = 0;
    let walletChunkResponses = 0;

    const attachPageDiagnostics = (observedPage: Page) => {
      if (observedPage !== page) unexpectedPages.push("[additional-page]");
      observedPage.on("console", (message) => {
        const classified = classifyConsoleMessage(
          message.type(),
          message.text(),
        );
        frontendEvents.push(classified);
        if (message.type() === "error") consoleErrors.push(classified);
      });
      observedPage.on("pageerror", (error) => {
        pageErrors.push(error.name || "Error");
      });
    };
    attachPageDiagnostics(page);
    context.on("page", attachPageDiagnostics);
    context.on("request", (request) => {
      const path = safeResourceLabel(request.url());
      const pathname = parseUrl(request.url())?.pathname ?? "";
      if (!isLoopbackOrLocalResource(request.url())) {
        nonLoopbackRequests.push(`${request.method()}:${path}`);
      }
      if (isForbiddenHttpAuthRequest(request.method(), pathname)) {
        forbiddenAuthRequests.push(`${request.method()}:${path}`);
      }
      if (
        pathname.includes("/assets/wallet-buttons-") ||
        pathname.includes("/assets/steward-wallet-providers-")
      ) {
        walletChunkRequests += 1;
      }
    });
    context.on("requestfailed", (request) => {
      requestFailures.push(
        `${request.method()}:${safeResourceLabel(request.url())}:${classifyRequestFailure(request.failure()?.errorText)}`,
      );
    });
    context.on("response", (response) => {
      const request = response.request();
      const url = parseUrl(response.url());
      const pathname = url?.pathname ?? "";
      frontendEvents.push(
        `response:${request.method()}:${response.status()}:${safeResourceLabel(response.url())}`,
      );
      if (response.status() >= 400) {
        httpErrors.push(
          `${request.method()}:${response.status()}:${safeResourceLabel(response.url())}`,
        );
      }
      if (isCanonicalProviderDiscovery(request.method(), pathname)) {
        providerDiscoveryResponses += 1;
      }
      if (
        pathname.includes("/assets/wallet-buttons-") ||
        pathname.includes("/assets/steward-wallet-providers-")
      ) {
        walletChunkResponses += 1;
      }
    });
    await context.routeWebSocket(/.*/, async (webSocket) => {
      const webSocketUrl = webSocket.url();
      const pathname = parseUrl(webSocketUrl)?.pathname ?? "";
      if (!isLoopbackOrLocalResource(webSocketUrl)) {
        nonLoopbackWebSockets.push("[external-origin]");
        await webSocket.close({ code: 1008, reason: "blocked by test policy" });
        return;
      }
      if (isAuthSurface(pathname)) {
        forbiddenAuthWebSockets.push(`WS:${safeResourceLabel(webSocketUrl)}`);
        await webSocket.close({ code: 1008, reason: "blocked by test policy" });
        return;
      }
      webSocket.connectToServer();
    });
    await installProviderFixture(context);

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const exactRendererCommitVerified = await assertExactEvidenceRenderer(page);
    expect(walletChunkRequests).toBe(0);
    expect(walletChunkResponses).toBe(0);

    const walletToggle = page.getByRole("button", {
      name: "Continue with a wallet",
    });
    await walletToggle.click();

    const walletRegion = page.locator("#steward-wallet-options");
    const evmButton = walletRegion.getByRole("button", {
      name: /^EVM(?: wallet)?$/,
    });
    const solanaButton = walletRegion.getByRole("button", {
      name: /^Solana(?: wallet)?$/,
    });
    await expect(evmButton).toBeVisible();
    await expect(solanaButton).toHaveCount(0);
    expect(
      walletChunkRequests,
      "wallet chunks must not be requested after disclosure alone",
    ).toBe(0);
    expect(
      walletChunkResponses,
      "wallet chunks must remain lazy after disclosure alone",
    ).toBe(0);
    expect(
      await page.evaluate(() => {
        const methods = Reflect.get(window, "__elizaWalletCapabilityMethods");
        return Array.isArray(methods) ? methods : [];
      }),
      "wallet discovery must not run before explicit chain intent",
    ).toEqual([]);

    await page.screenshot({
      path: testInfo.outputPath(
        `after-${viewport.name}-siwe-only-disclosed-${EVIDENCE_REVISION}.jpg`,
      ),
      fullPage: true,
      quality: 88,
      type: "jpeg",
    });

    // The first provider click crosses the lazy boundary. The deterministic
    // EIP-1193 fixture keeps account access pending, so no wallet is authorized
    // and the resulting frame remains clean capability evidence.
    await evmButton.click();
    await expect(
      page.getByRole("button", { name: /Wallet options/i }),
    ).toBeDisabled();
    await expect(evmButton).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.waitForLoadState("networkidle");

    await expect(evmButton).toHaveCount(1);
    await expect(solanaButton).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(providerDiscoveryResponses).toBe(1);
    expect(walletChunkRequests).toBeGreaterThanOrEqual(2);
    expect(walletChunkResponses).toBeGreaterThanOrEqual(2);
    const walletMethods = await page.evaluate(() => {
      const methods = Reflect.get(window, "__elizaWalletCapabilityMethods");
      return Array.isArray(methods)
        ? methods.filter(
            (method): method is string => typeof method === "string",
          )
        : [];
    });
    expect(walletMethods).toContain("eth_accounts");
    expect(
      walletMethods.filter((method) => method !== "eth_accounts"),
      "the capability proof must not request accounts or signatures",
    ).toEqual([]);

    const expectCleanDiagnostics = () => {
      expect(
        pageErrors,
        "the rendered login must not raise page errors",
      ).toEqual([]);
      expect(
        consoleErrors,
        "the rendered login must not emit console errors",
      ).toEqual([]);
      expect(
        requestFailures,
        "the capability flow must not leave failed requests",
      ).toEqual([]);
      expect(
        httpErrors,
        "the capability flow must not receive HTTP errors",
      ).toEqual([]);
      expect(
        nonLoopbackRequests,
        "the fixture-backed flow must not reach any external origin",
      ).toEqual([]);
      expect(
        nonLoopbackWebSockets,
        "the fixture-backed flow must not open external WebSockets",
      ).toEqual([]);
      expect(
        forbiddenAuthWebSockets,
        "the capability proof must not open an auth WebSocket",
      ).toEqual([]);
      expect(
        forbiddenAuthRequests,
        "the capability proof must not start OAuth or wallet auth",
      ).toEqual([]);
      expect(
        unexpectedPages,
        "the capability proof must not open a popup or secondary page",
      ).toEqual([]);
    };
    expectCleanDiagnostics();

    await page.screenshot({
      path: testInfo.outputPath(
        `after-${viewport.name}-siwe-only-lazy-stack-${EVIDENCE_REVISION}.jpg`,
      ),
      fullPage: true,
      quality: 88,
      type: "jpeg",
    });

    const frontendLogPath = testInfo.outputPath(
      `after-${viewport.name}-frontend-network-${EVIDENCE_REVISION}.log`,
    );

    const video = page.video();
    await page.context().close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expectCleanDiagnostics();

    await writeFile(
      frontendLogPath,
      `${[
        "assertion:page-errors=0",
        "assertion:console-errors=0",
        "assertion:request-failures=0",
        "assertion:http-errors=0",
        "assertion:non-loopback-egress=0",
        "assertion:non-loopback-websockets=0",
        "assertion:forbidden-auth-requests=0",
        "assertion:forbidden-auth-websockets=0",
        "assertion:unexpected-pages=0",
        `assertion:renderer-commit-match=${exactRendererCommitVerified ? "1" : "0"}`,
        `assertion:formal-evidence-mode=${requestedEvidenceHead ? "1" : "0"}`,
        `assertion:provider-discovery-responses=${providerDiscoveryResponses}`,
        `assertion:wallet-chunk-requests=${walletChunkRequests}`,
        `assertion:wallet-chunk-responses=${walletChunkResponses}`,
        `assertion:wallet-methods=${walletMethods.join(",")}`,
        ...frontendEvents,
      ].join("\n")}\n`,
    );
    await testInfo.attach(`${viewport.name} frontend network log`, {
      path: frontendLogPath,
      contentType: "text/plain",
    });

    if (video) {
      const artifact = await saveBrowserVideoArtifact({
        video,
        testInfo,
        basename: `after-${viewport.name}-wallet-capability-walkthrough-${EVIDENCE_REVISION}`,
      });
      if (requestedEvidenceHead) {
        expect(artifact.contentType).toBe("video/mp4");
      }
      await testInfo.attach(`${viewport.name} wallet capability walkthrough`, {
        path: artifact.path,
        contentType: artifact.contentType,
      });
    }
  });
}
