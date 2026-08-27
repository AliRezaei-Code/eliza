/**
 * Real-browser regression and PR evidence for the hosted sign-in wallet
 * capability boundary. The lightweight disclosure and the lazy wallet stack
 * must both obey the same provider discovery response.
 */
import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

test.use({ video: { mode: "on", size: { width: 1440, height: 900 } } });

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

async function installProviderFixture(page: Page): Promise<void> {
  // Keep the provider-backed intent pending after the lazy boundary. The test
  // proves capability rendering, not an account authorization, and must not
  // open a real wallet or paint a synthetic connection failure into evidence.
  await page.addInitScript(() => {
    const ethereum = {
      request: ({ method }: { method: string }) => {
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
  await page.route("**/auth/providers", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SIWE_ONLY_PROVIDERS),
    });
  });
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function safePath(rawUrl: string): string {
  const url = parseUrl(rawUrl);
  if (!url) return "[unparseable-url]";
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return `[${url.protocol.slice(0, -1)}-url]`;
  }
  return `${url.origin}${url.pathname}`;
}

function isLoopbackOrLocalResource(rawUrl: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
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

for (const viewport of VIEWPORTS) {
  test(`lazy wallet stack preserves SIWE-only discovery at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await installProviderFixture(page);

    const frontendEvents: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const nonLoopbackRequests: string[] = [];
    const forbiddenAuthRequests: string[] = [];
    const consoleErrors: string[] = [];
    let providerDiscoveryResponses = 0;
    let walletChunkResponses = 0;
    page.on("console", (message) => {
      const classified = classifyConsoleMessage(message.type(), message.text());
      frontendEvents.push(classified);
      if (message.type() === "error") consoleErrors.push(classified);
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.name || "Error");
    });
    page.on("request", (request) => {
      const path = safePath(request.url());
      if (!isLoopbackOrLocalResource(request.url())) {
        nonLoopbackRequests.push(`${request.method()}:${path}`);
      }
      if (/\/auth\/(?:siwe|siws|oauth)\//i.test(path)) {
        forbiddenAuthRequests.push(`${request.method()}:${path}`);
      }
    });
    page.on("requestfailed", (request) => {
      requestFailures.push(
        `${request.method()}:${safePath(request.url())}:${request.failure()?.errorText ?? "unknown"}`,
      );
    });
    page.on("response", (response) => {
      const request = response.request();
      const url = parseUrl(response.url());
      const pathname = url?.pathname ?? "";
      frontendEvents.push(
        `response:${request.method()}:${response.status()}:${safePath(response.url())}`,
      );
      if (pathname.endsWith("/steward/auth/providers")) {
        providerDiscoveryResponses += 1;
      }
      if (
        pathname.includes("/assets/wallet-buttons-") ||
        pathname.includes("/assets/steward-wallet-providers-")
      ) {
        walletChunkResponses += 1;
      }
    });

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

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

    await page.screenshot({
      path: testInfo.outputPath(
        `after-${viewport.name}-siwe-only-disclosed.jpg`,
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

    await expect(evmButton).toHaveCount(1);
    await expect(solanaButton).toHaveCount(0);
    expect(providerDiscoveryResponses).toBe(1);
    expect(walletChunkResponses).toBeGreaterThanOrEqual(2);
    expect(pageErrors, "the rendered login must not raise page errors").toEqual(
      [],
    );
    expect(
      consoleErrors,
      "the rendered login must not emit console errors",
    ).toEqual([]);
    expect(
      requestFailures,
      "the capability flow must not leave failed requests",
    ).toEqual([]);
    expect(
      nonLoopbackRequests,
      "the fixture-backed flow must not reach any external origin",
    ).toEqual([]);
    expect(
      forbiddenAuthRequests,
      "the capability proof must not start OAuth or wallet auth",
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(
        `after-${viewport.name}-siwe-only-lazy-stack.jpg`,
      ),
      fullPage: true,
      quality: 88,
      type: "jpeg",
    });

    const frontendLogPath = testInfo.outputPath(
      `after-${viewport.name}-frontend-network.log`,
    );
    await writeFile(
      frontendLogPath,
      `${[
        "assertion:page-errors=0",
        "assertion:console-errors=0",
        "assertion:request-failures=0",
        "assertion:non-loopback-egress=0",
        "assertion:forbidden-auth-requests=0",
        `assertion:provider-discovery-responses=${providerDiscoveryResponses}`,
        `assertion:wallet-chunk-responses=${walletChunkResponses}`,
        ...frontendEvents,
      ].join("\n")}\n`,
    );
    await testInfo.attach(`${viewport.name} frontend network log`, {
      path: frontendLogPath,
      contentType: "text/plain",
    });

    const video = page.video();
    await page.context().close();
    if (video) {
      const artifact = await saveBrowserVideoArtifact({
        video,
        testInfo,
        basename: `after-${viewport.name}-wallet-capability-walkthrough`,
      });
      await testInfo.attach(`${viewport.name} wallet capability walkthrough`, {
        path: artifact.path,
        contentType: artifact.contentType,
      });
    }
  });
}
