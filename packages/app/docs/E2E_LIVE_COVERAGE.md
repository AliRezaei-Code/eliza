# Application test lanes

Application validation is organized by trust boundary, not by one workflow per
feature.

## Pull requests

`.github/workflows/pr-static-smoke.yml` is the sole pull-request and merge-group
workflow. It publishes the stable `All Tests Passed` status after mergeability,
diff, secret, workflow-syntax, frozen-install, core-build, and affected static
checks. Full repository tests and deterministic E2E run after merge through the
develop validation authority, not on pull requests.

The pull-request lane is credential-free. It uses deterministic model fixtures,
local services, and checked-in browser fixtures. A test that requires a hosted
model, Railway service, production account, physical device, or store signing
does not belong in this lane.

### Formal PR browser evidence

Capture the hosted sign-in capability proof from a clean checkout at the exact
commit being reviewed:

```bash
ELIZA_PR_EVIDENCE_HEAD="$(git rev-parse HEAD)" \
  bun run --cwd packages/app test:e2e -- \
  --project=chromium test/ui-smoke/hosted-signin-wallet-capability.spec.ts
```

`ELIZA_PR_EVIDENCE_HEAD` must be the full 40-character SHA matching the clean
checked-out `HEAD`. Formal mode accepts only the canonical
`packages/app/playwright.ui-smoke.config.ts` configuration. It rejects
`ELIZA_UI_SMOKE_REUSE_SERVER=1`, `ELIZA_UI_SMOKE_SKIP_BUILD=1`,
`ELIZA_UI_SMOKE_SKIP_VIEW_BUILD=1`, `ELIZA_UI_SMOKE_SKIP_CORE_BUILD=1`, and
local Vite inputs at `packages/app/.env`, `.env.local`, `.env.production`, or
`.env.production.local`. The invocation rebuilds the app renderer and views,
then cleans and force-rebuilds the linked `@elizaos/shared` and
`@elizaos/core` outputs before recording evidence. Regenerate the artifacts
whenever `HEAD` changes.

Use the package script above rather than invoking `bunx playwright` directly.
In formal mode, the wrapper seals the freshly rebuilt view/shared/core outputs
in an invocation-bound receipt, including every regular file in the linked
shared/core `dist` trees and every discovered view bundle. The Playwright
config validates that receipt before creating its web server, so a direct
`--config` entry or stale ignored build output fails closed. The handoff is
accepted only while its wrapper PID is live and for at most 24 hours after the
build; a later runner removes dead, expired, or stale-incomplete receipts.

This gate proves consistency between the caller-supplied SHA, local clean
checkout, and rendered manifest. It does not resolve or attest a GitHub PR ref
or trusted remote origin; verify the intended PR head independently before
describing the artifacts as PR provenance.

## Nightly

`.github/workflows/nightly.yml` reuses the consolidated CI workflow and adds
macOS and Windows platform smoke. It does not publish packages or deploy
infrastructure.

## Live services

`.github/workflows/live-smoke.yml` is the general credential-backed dispatcher.
The dispatch input selects `app`, `scenarios`, `cloud`, `voice`, or `all`.
Credential-backed failures are therefore visible without making ordinary
repository health depend on secret availability or third-party uptime.
Specialized app and voice evidence also flows through `app-live-e2e.yml` and
`voice-live-e2e.yml`, which run on schedule or dispatch.

## Platform and release evidence

iOS, Android, desktop packaging, store signing, and physical-device evidence
are operator-run release checks. Their commands remain in `packages/app` and
`packages/app-core`; they are not automatic pull-request fan-out.

Run the narrow package command while developing, then use the repository gates
before review:

```bash
bun run --cwd packages/app test
bun run --cwd packages/app test:e2e
bun run --cwd packages/app audit:app
bun run verify
```
