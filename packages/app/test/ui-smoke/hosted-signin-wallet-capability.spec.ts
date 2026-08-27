/**
 * Real-browser regression and PR evidence for the hosted sign-in wallet
 * capability boundary. The lightweight disclosure and the lazy wallet stack
 * must both obey the same provider discovery response.
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type BrowserContext,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
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
  if (pathname.startsWith("/assets/")) return false;

  const hasAuthRouteSegment = pathname
    .split("/")
    .filter(Boolean)
    .some((segment) =>
      /^(?:(?:[a-z0-9]+[-_])*(?:auth|oauth2?|oidc|callback|pair|pairing)(?:[-_][a-z0-9]+)*|authorize|authorization|authentication)$/i.test(
        segment,
      ),
    );

  return (
    hasAuthRouteSegment ||
    /^\/api(?:\/[^/]+)*\/login(?:\/|$)/i.test(pathname) ||
    /^\/(?:api\/)?\.well-known\/openid-configuration\/?$/i.test(pathname) ||
    /^\/api(?:\/[^/]+)*\/(?:set-)?anonymous-session(?:\/|$)/i.test(pathname)
  );
}

function isForbiddenHttpAuthRequest(method: string, pathname: string): boolean {
  return (
    isAuthSurface(pathname) && !isCanonicalProviderDiscovery(method, pathname)
  );
}

function isForbiddenLocalServiceRequest(
  method: string,
  pathname: string,
): boolean {
  return (
    /^\/(?:api|steward)(?:\/|$)/i.test(pathname) &&
    !isCanonicalProviderDiscovery(method, pathname)
  );
}

function isBrowserDataRequest(resourceType: string): boolean {
  return ["eventsource", "fetch", "ping", "xhr"].includes(resourceType);
}

function isRendererManifestRequest(method: string, pathname: string): boolean {
  return method === "GET" && pathname === "/eliza-renderer-build.json";
}

function canonicalizePathname(pathname: string): string | null {
  let canonical = pathname;
  for (let depth = 0; depth < 4; depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(canonical);
    } catch {
      return null;
    }
    if (decoded === canonical) return canonical;
    canonical = decoded;
  }
  return null;
}

function resolveRequestPath(rawUrl: string): {
  canonical: boolean;
  pathname: string;
} | null {
  const url = parseUrl(rawUrl);
  if (!url) return null;
  const pathname = canonicalizePathname(url.pathname);
  if (pathname === null) return null;
  return { canonical: pathname === url.pathname, pathname };
}

function isExactRendererUrl(
  rawUrl: string,
  expectedRendererOrigin: string,
  expectedPathname: string,
): boolean {
  const url = parseUrl(rawUrl);
  const requestPath = resolveRequestPath(rawUrl);
  return (
    url?.origin === expectedRendererOrigin &&
    requestPath?.canonical === true &&
    requestPath.pathname === expectedPathname &&
    url.search === "" &&
    url.hash === ""
  );
}

function isExactProviderDiscoveryRequest(
  method: string,
  rawUrl: string,
  resourceType: string,
  expectedRendererOrigin: string,
): boolean {
  return (
    method === "GET" &&
    (resourceType === "fetch" || resourceType === "xhr") &&
    isExactRendererUrl(
      rawUrl,
      expectedRendererOrigin,
      "/steward/auth/providers",
    )
  );
}

function isExactRendererManifestRequest(
  method: string,
  rawUrl: string,
  resourceType: string,
  expectedRendererOrigin: string,
): boolean {
  return (
    method === "GET" &&
    (resourceType === "fetch" || resourceType === "xhr") &&
    isExactRendererUrl(
      rawUrl,
      expectedRendererOrigin,
      "/eliza-renderer-build.json",
    )
  );
}

function isAllowedStaticRendererRequest(
  method: string,
  rawUrl: string,
  expectedRendererOrigin: string,
): boolean {
  if (method !== "GET") return false;
  const url = parseUrl(rawUrl);
  const requestPath = resolveRequestPath(rawUrl);
  if (
    url?.origin !== expectedRendererOrigin ||
    requestPath?.canonical !== true ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return false;
  }
  return (
    requestPath.pathname.startsWith("/assets/") ||
    requestPath.pathname.startsWith("/brand/") ||
    requestPath.pathname === "/site.webmanifest"
  );
}

function isAllowedRendererNonDocumentRequest(
  method: string,
  rawUrl: string,
  resourceType: string,
  expectedRendererOrigin: string,
): boolean {
  return (
    isExactProviderDiscoveryRequest(
      method,
      rawUrl,
      resourceType,
      expectedRendererOrigin,
    ) ||
    isExactRendererManifestRequest(
      method,
      rawUrl,
      resourceType,
      expectedRendererOrigin,
    ) ||
    isAllowedStaticRendererRequest(method, rawUrl, expectedRendererOrigin)
  );
}

function isForbiddenLocalDataRequest(
  method: string,
  pathname: string,
  resourceType: string,
): boolean {
  return (
    isBrowserDataRequest(resourceType) &&
    !isCanonicalProviderDiscovery(method, pathname) &&
    !isRendererManifestRequest(method, pathname)
  );
}

function isAllowedInitialLoginDocument(
  method: string,
  rawUrl: string,
  resourceType: string,
  expectedRendererOrigin: string,
): boolean {
  const url = parseUrl(rawUrl);
  return (
    method === "GET" &&
    resourceType === "document" &&
    url?.origin === expectedRendererOrigin &&
    url.pathname === "/login" &&
    url.search === "" &&
    url.hash === ""
  );
}

function createInitialLoginDocumentGate(
  expectedRendererOrigin: string,
): (
  method: string,
  rawUrl: string,
  resourceType: string,
  isExpectedMainFrame: boolean,
) => boolean {
  let documentConsumed = false;
  return (method, rawUrl, resourceType, isExpectedMainFrame) => {
    if (resourceType !== "document" || documentConsumed) return false;
    documentConsumed = true;
    return (
      isExpectedMainFrame &&
      isAllowedInitialLoginDocument(
        method,
        rawUrl,
        resourceType,
        expectedRendererOrigin,
      )
    );
  };
}

async function installProviderFixture(
  context: BrowserContext,
  page: Page,
  expectedRendererOrigin: string,
): Promise<void> {
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
  const consumeInitialLoginDocument = createInitialLoginDocumentGate(
    expectedRendererOrigin,
  );
  await context.route("**/*", async (route) => {
    const request = route.request();
    const requestUrl = request.url();
    const requestPath = resolveRequestPath(requestUrl);
    if (!isExpectedRendererResource(requestUrl, expectedRendererOrigin)) {
      await route.abort("blockedbyclient");
      return;
    }
    // Reject encoded, multiply encoded, and malformed renderer paths before
    // routing. Framework routers may decode those paths and otherwise turn an
    // apparently harmless resource into a real /api or /steward request.
    if (!requestPath?.canonical) {
      await route.abort("blockedbyclient");
      return;
    }
    if (
      request.resourceType() === "document" &&
      !consumeInitialLoginDocument(
        request.method(),
        requestUrl,
        request.resourceType(),
        request.frame() === page.mainFrame(),
      )
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    if (
      isExactProviderDiscoveryRequest(
        request.method(),
        requestUrl,
        request.resourceType(),
        expectedRendererOrigin,
      )
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SIWE_ONLY_PROVIDERS),
      });
      return;
    }
    if (
      request.resourceType() !== "document" &&
      !isAllowedRendererNonDocumentRequest(
        request.method(),
        requestUrl,
        request.resourceType(),
        expectedRendererOrigin,
      )
    ) {
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

function safeResourceLabel(
  rawUrl: string,
  expectedRendererOrigin: string,
): string {
  const url = parseUrl(rawUrl);
  if (!url) return "[unparseable-url]";
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return `[${url.protocol.slice(0, -1)}-url]`;
  }
  if (!isExpectedRendererResource(rawUrl, expectedRendererOrigin)) {
    return "[unexpected-origin]";
  }
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
  // Unknown renderer-origin paths can still contain callback codes, session ids, or
  // other credentials. Keep them useful only as a resource class.
  return "[local-resource]";
}

function isExpectedRendererResource(
  rawUrl: string,
  expectedRendererOrigin: string,
): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  if (url.protocol === "data:" || url.protocol === "blob:") return true;

  const expected = new URL(expectedRendererOrigin);
  if (url.protocol === "http:" || url.protocol === "https:") {
    return url.origin === expected.origin;
  }

  const expectedSocketProtocol =
    expected.protocol === "https:" ? "wss:" : "ws:";
  return url.protocol === expectedSocketProtocol && url.host === expected.host;
}

function resolveExpectedRendererOrigin(testInfo: TestInfo): string {
  const configuredBaseUrl = testInfo.project.use.baseURL;
  if (typeof configuredBaseUrl !== "string") {
    throw new Error(
      "Hosted login evidence requires a configured string baseURL",
    );
  }
  return new URL(configuredBaseUrl).origin;
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

test("hosted login egress policy covers every current auth route family", () => {
  const authCases = [
    ["POST", "/steward/auth/providers"],
    ["GET", "/app-auth/authorize"],
    ["POST", "/api/v1/app-auth/connect"],
    ["GET", "/api/v1/app-auth/mobile/config"],
    ["POST", "/api/v1/cli-auth/start"],
    ["GET", "/api/eliza-app/cli-auth/status"],
    ["POST", "/api/v1/oauth/google/initiate"],
    ["POST", "/api/cloud/v1/oauth/x/initiate"],
    ["POST", "/api/v1/oauth-intents"],
    ["GET", "/oidc/continue"],
    ["GET", "/api/oidc/authorize"],
    ["POST", "/api/oidc/token"],
    ["GET", "/.well-known/openid-configuration"],
    ["GET", "/api/.well-known/openid-configuration"],
    ["GET", "/pair"],
    ["POST", "/api/v1/remote/pair"],
    ["POST", "/api/whatsapp/pair"],
    ["POST", "/api/v1/eliza/agents/example/pairing-token"],
    ["GET", "/api/discord/oauth"],
    ["GET", "/api/v1/discord/callback"],
    ["GET", "/api/v1/twitter/callback"],
    ["POST", "/api/discord-local/authorize"],
    ["POST", "/api/accounts/openai-codex/oauth/start"],
    ["GET", "/api/connectors/google/oauth/callback"],
    ["POST", "/api/v1/eliza/paypal/authorize"],
    ["GET", "/api/v1/eliza/paypal/popup-callback"],
    ["POST", "/api/set-anonymous-session"],
    ["GET", "/api/anonymous-session"],
    ["POST", "/api/cloud/login"],
    ["GET", "/api/cloud/login/status"],
    ["POST", "/api/cloud/login/persist"],
  ] as const;

  for (const [method, pathname] of authCases) {
    expect(
      isForbiddenHttpAuthRequest(method, pathname),
      `${method} ${pathname} must be classified as auth egress`,
    ).toBe(true);
  }

  expect(isForbiddenHttpAuthRequest("GET", "/steward/auth/providers")).toBe(
    false,
  );
  expect(isForbiddenHttpAuthRequest("GET", "/login")).toBe(false);
  expect(
    isForbiddenHttpAuthRequest("GET", "/assets/auth-provider-example.js"),
  ).toBe(false);

  for (const [method, pathname] of [
    ["GET", "/api/health"],
    ["POST", "/api/cloud/v1/twitter/connect"],
    ["GET", "/steward/session"],
  ] as const) {
    expect(
      isForbiddenLocalServiceRequest(method, pathname),
      `${method} ${pathname} must be blocked by the local service allowlist`,
    ).toBe(true);
  }
  expect(isForbiddenLocalServiceRequest("GET", "/steward/auth/providers")).toBe(
    false,
  );

  expect(
    isForbiddenLocalDataRequest("GET", "/eliza-renderer-build.json", "fetch"),
  ).toBe(false);
  expect(
    isForbiddenLocalDataRequest("GET", "/steward/auth/providers", "fetch"),
  ).toBe(false);
  expect(
    isForbiddenLocalDataRequest(
      "POST",
      "/api/cloud/v1/twitter/connect",
      "fetch",
    ),
  ).toBe(true);
  expect(isForbiddenLocalDataRequest("GET", "/assets/app.js", "script")).toBe(
    false,
  );
  expect(isBrowserDataRequest("ping")).toBe(true);
  expect(isBrowserDataRequest("eventsource")).toBe(true);

  const expectedOrigin = "http://127.0.0.1:2138";
  expect(
    isAllowedInitialLoginDocument(
      "GET",
      `${expectedOrigin}/login`,
      "document",
      expectedOrigin,
    ),
  ).toBe(true);
  for (const url of [
    `${expectedOrigin}/login?code=redacted&state=redacted`,
    `${expectedOrigin}/pair?token=redacted`,
    "http://127.0.0.1:31337/login",
    "http://localhost:2138/login",
    "http://[::1]:2138/login",
  ]) {
    expect(
      isAllowedInitialLoginDocument("GET", url, "document", expectedOrigin),
      `${url} must not be accepted as the initial login document`,
    ).toBe(false);
  }
  expect(
    isExpectedRendererResource(
      "http://127.0.0.1:31337/eliza-renderer-build.json",
      expectedOrigin,
    ),
  ).toBe(false);
  expect(
    isExpectedRendererResource(
      "http://localhost:2138/assets/app.js",
      expectedOrigin,
    ),
  ).toBe(false);

  for (const [encodedPath, canonicalPath] of [
    [
      "/%61pi/v1/eliza/lifeops/github-complete",
      "/api/v1/eliza/lifeops/github-complete",
    ],
    ["/%73teward/session", "/steward/session"],
    ["/%2561pi/cloud/v1/twitter/connect", "/api/cloud/v1/twitter/connect"],
  ] as const) {
    const resolved = resolveRequestPath(`${expectedOrigin}${encodedPath}`);
    expect(resolved?.pathname).toBe(canonicalPath);
    expect(resolved?.canonical).toBe(false);
    expect(
      isForbiddenLocalServiceRequest("GET", resolved?.pathname ?? ""),
      `${encodedPath} must classify as its decoded local service path`,
    ).toBe(true);
  }
  expect(resolveRequestPath(`${expectedOrigin}/%zz`)).toBeNull();

  expect(
    isExactProviderDiscoveryRequest(
      "GET",
      `${expectedOrigin}/steward/auth/providers`,
      "fetch",
      expectedOrigin,
    ),
  ).toBe(true);
  expect(
    isExactProviderDiscoveryRequest(
      "GET",
      `${expectedOrigin}/steward/auth/providers?state=redacted`,
      "fetch",
      expectedOrigin,
    ),
    "provider discovery with query state must not enter the fixture allowlist",
  ).toBe(false);
  expect(
    isAllowedStaticRendererRequest(
      "GET",
      `${expectedOrigin}/brand/logos/logo_white_nobg.svg`,
      expectedOrigin,
    ),
  ).toBe(true);
  for (const [method, url, resourceType] of [
    ["POST", `${expectedOrigin}/assets/index.js`, "script"],
    ["GET", `${expectedOrigin}/assets/index.js?callback=redacted`, "script"],
    [
      "GET",
      `${expectedOrigin}/brand/favicons/favicon.svg?state=redacted`,
      "image",
    ],
    ["GET", `${expectedOrigin}/telemetry.gif?state=redacted`, "image"],
    ["GET", `${expectedOrigin}/events`, "eventsource"],
    ["GET", `${expectedOrigin}/steward/auth/providers`, "script"],
    ["GET", `${expectedOrigin}/eliza-renderer-build.json`, "image"],
  ] as const) {
    expect(
      isAllowedRendererNonDocumentRequest(
        method,
        url,
        resourceType,
        expectedOrigin,
      ),
      `${method} ${resourceType} ${url} must remain outside the exact non-document allowlist`,
    ).toBe(false);
  }

  const consumeInitialLoginDocument =
    createInitialLoginDocumentGate(expectedOrigin);
  expect(
    consumeInitialLoginDocument(
      "GET",
      `${expectedOrigin}/login`,
      "document",
      true,
    ),
  ).toBe(true);
  expect(
    consumeInitialLoginDocument(
      "GET",
      `${expectedOrigin}/login`,
      "document",
      true,
    ),
    "an exact same-URL reload must not receive a second document allowance",
  ).toBe(false);

  const rejectIframeAsInitialDocument =
    createInitialLoginDocumentGate(expectedOrigin);
  expect(
    rejectIframeAsInitialDocument(
      "GET",
      `${expectedOrigin}/login`,
      "document",
      false,
    ),
    "an iframe must not consume an apparently valid initial login document",
  ).toBe(false);
});

for (const viewport of VIEWPORTS) {
  test(`lazy wallet stack preserves SIWE-only discovery at ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const context = page.context();
    const expectedRendererOrigin = resolveExpectedRendererOrigin(testInfo);
    const expectedLoginUrl = `${expectedRendererOrigin}/login`;

    const frontendEvents: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const unexpectedOriginRequests: string[] = [];
    const unexpectedOriginWebSockets: string[] = [];
    const forbiddenAuthWebSockets: string[] = [];
    const unexpectedLocalWebSockets: string[] = [];
    const unexpectedLocalServiceRequests: string[] = [];
    const unexpectedLocalDataRequests: string[] = [];
    const unexpectedLocalResourceRequests: string[] = [];
    const unexpectedNonCanonicalPathRequests: string[] = [];
    const documentRequests: string[] = [];
    const unexpectedDocumentRequests: string[] = [];
    const unexpectedMainFrameNavigations: string[] = [];
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
      observedPage.on("framenavigated", (frame) => {
        if (
          observedPage === page &&
          frame === observedPage.mainFrame() &&
          frame.url() !== expectedLoginUrl
        ) {
          unexpectedMainFrameNavigations.push(
            "[unexpected-main-frame-navigation]",
          );
        }
      });
    };
    attachPageDiagnostics(page);
    context.on("page", attachPageDiagnostics);
    context.on("request", (request) => {
      const path = safeResourceLabel(request.url(), expectedRendererOrigin);
      const requestPath = resolveRequestPath(request.url());
      const pathname = requestPath?.pathname ?? "";
      if (!isExpectedRendererResource(request.url(), expectedRendererOrigin)) {
        unexpectedOriginRequests.push(`${request.method()}:${path}`);
      }
      if (!requestPath?.canonical) {
        unexpectedNonCanonicalPathRequests.push(`${request.method()}:${path}`);
      }
      if (isForbiddenHttpAuthRequest(request.method(), pathname)) {
        forbiddenAuthRequests.push(`${request.method()}:${path}`);
      }
      if (
        isExpectedRendererResource(request.url(), expectedRendererOrigin) &&
        isForbiddenLocalServiceRequest(request.method(), pathname)
      ) {
        unexpectedLocalServiceRequests.push(`${request.method()}:${path}`);
      }
      if (
        isExpectedRendererResource(request.url(), expectedRendererOrigin) &&
        isBrowserDataRequest(request.resourceType()) &&
        !isExactProviderDiscoveryRequest(
          request.method(),
          request.url(),
          request.resourceType(),
          expectedRendererOrigin,
        ) &&
        !isExactRendererManifestRequest(
          request.method(),
          request.url(),
          request.resourceType(),
          expectedRendererOrigin,
        )
      ) {
        unexpectedLocalDataRequests.push(`${request.method()}:${path}`);
      }
      if (
        isExpectedRendererResource(request.url(), expectedRendererOrigin) &&
        request.resourceType() !== "document" &&
        !isAllowedRendererNonDocumentRequest(
          request.method(),
          request.url(),
          request.resourceType(),
          expectedRendererOrigin,
        )
      ) {
        unexpectedLocalResourceRequests.push(`${request.method()}:${path}`);
      }
      if (request.resourceType() === "document") {
        const documentLabel = `${request.method()}:${path}`;
        documentRequests.push(documentLabel);
        if (
          documentRequests.length !== 1 ||
          request.frame() !== page.mainFrame() ||
          !isAllowedInitialLoginDocument(
            request.method(),
            request.url(),
            request.resourceType(),
            expectedRendererOrigin,
          )
        ) {
          unexpectedDocumentRequests.push(documentLabel);
        }
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
        `${request.method()}:${safeResourceLabel(request.url(), expectedRendererOrigin)}:${classifyRequestFailure(request.failure()?.errorText)}`,
      );
    });
    context.on("response", (response) => {
      const request = response.request();
      const url = parseUrl(response.url());
      const pathname = url?.pathname ?? "";
      frontendEvents.push(
        `response:${request.method()}:${response.status()}:${safeResourceLabel(response.url(), expectedRendererOrigin)}`,
      );
      if (response.status() >= 400) {
        httpErrors.push(
          `${request.method()}:${response.status()}:${safeResourceLabel(response.url(), expectedRendererOrigin)}`,
        );
      }
      if (
        isExactProviderDiscoveryRequest(
          request.method(),
          response.url(),
          request.resourceType(),
          expectedRendererOrigin,
        )
      ) {
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
      if (!isExpectedRendererResource(webSocketUrl, expectedRendererOrigin)) {
        unexpectedOriginWebSockets.push("[unexpected-origin]");
        await webSocket.close({ code: 1008, reason: "blocked by test policy" });
        return;
      }
      if (isAuthSurface(pathname)) {
        forbiddenAuthWebSockets.push(
          `WS:${safeResourceLabel(webSocketUrl, expectedRendererOrigin)}`,
        );
      }
      unexpectedLocalWebSockets.push("WS:[local-resource]");
      await webSocket.close({ code: 1008, reason: "blocked by test policy" });
    });
    await installProviderFixture(context, page, expectedRendererOrigin);

    await page.goto(expectedLoginUrl);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page).toHaveURL(expectedLoginUrl);
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
    await expect(page).toHaveURL(expectedLoginUrl);

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
        unexpectedOriginRequests,
        "the fixture-backed flow must not reach any origin other than the exact renderer origin",
      ).toEqual([]);
      expect(
        unexpectedOriginWebSockets,
        "the fixture-backed flow must not open WebSockets to another origin",
      ).toEqual([]);
      expect(
        forbiddenAuthWebSockets,
        "the capability proof must not open an auth WebSocket",
      ).toEqual([]);
      expect(
        unexpectedLocalWebSockets,
        "the capability proof must not open any local WebSocket",
      ).toEqual([]);
      expect(
        unexpectedLocalDataRequests,
        "the capability proof must not make unallowlisted local data requests",
      ).toEqual([]);
      expect(
        unexpectedLocalResourceRequests,
        "the capability proof must not make any exact-origin request outside the document, discovery, manifest, and static-resource allowlist",
      ).toEqual([]);
      expect(
        unexpectedLocalServiceRequests,
        "the capability proof must not reach an unallowlisted local service endpoint",
      ).toEqual([]);
      expect(
        unexpectedNonCanonicalPathRequests,
        "the capability proof must not request an encoded, multiply encoded, or malformed renderer path",
      ).toEqual([]);
      expect(
        documentRequests,
        "the capability proof must request exactly one canonical main-frame login document",
      ).toEqual(["GET:[login-route]"]);
      expect(
        unexpectedDocumentRequests,
        "the capability proof must not request a second or non-canonical document",
      ).toEqual([]);
      expect(
        unexpectedMainFrameNavigations,
        "the capability proof must remain on the exact login URL without callback query or fragment state",
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
        "assertion:unexpected-origin-egress=0",
        "assertion:unexpected-origin-websockets=0",
        "assertion:forbidden-auth-requests=0",
        "assertion:forbidden-auth-websockets=0",
        "assertion:unexpected-local-websockets=0",
        "assertion:unexpected-local-service-requests=0",
        "assertion:unexpected-local-data-requests=0",
        "assertion:unexpected-local-resource-requests=0",
        "assertion:unexpected-noncanonical-path-requests=0",
        "assertion:document-requests=1",
        "assertion:unexpected-document-requests=0",
        "assertion:unexpected-main-frame-navigations=0",
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
