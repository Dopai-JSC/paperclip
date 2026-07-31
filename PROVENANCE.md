# Provenance — Dopai-JSC/paperclip (Dopaios seed fork)

This repository is the Dopaios seed fork governed by the Dopaios architecture
verification plan (ARCH-VERIFICATION-PLAN-DOPAIOS-001, revision 4). Every
third-party component in use must have a source, a pin or digest, a license
check, and a scan result. This file records provenance for the fork itself and
for components added or removed during Bước nền; the dependency long tail is
covered by `pnpm-lock.yaml` plus the generated SBOM.

## Seed

| Field | Value |
|---|---|
| Upstream | https://github.com/paperclipai/paperclip |
| Fork | https://github.com/Dopai-JSC/paperclip |
| Pin | tag `v2026.707.0` = commit `390627b46eb333309d357004384b220ecf8a65af` (2026-07-07) |
| License at pin | MIT (LICENSE, "Copyright (c) 2025 Paperclip AI") |

## Upstream commits cherry-picked (controlled)

| Commit | Upstream PR | Note |
|---|---|---|
| `85404b46c5` | #9651 throttle serial recovery repeats | applied; signature context from intermediate commits dropped |
| `c65ab09d9f` | #9635 wait for provider quota resets | applied; durable-wait/continuation context from #9373 and others dropped; StrandedRecoveryCause widened at tag |
| `53f09cb818` | #9648 prevent duplicate task creation and recovery loops | partially applied: recovery cooldown + productivity-review hardening only. The issue-create idempotency retention part depends on base tables from #9650/#9649 which are not at the tag and were NOT cherry-picked. |

## Components removed in the fork

- `skills/para-memory-files/` and every code reference (skills index, CEO
  onboarding bundle, UI fixture) — per Dopaios ADR-008 direction.
- Outbound telemetry/feedback share endpoints: `server/src/services/feedback-share-client.ts`
  deleted; `packages/shared/src/telemetry/client.ts` ships no default endpoints
  (`telemetry.paperclip.ing` and the AWS ingest fallback removed). Telemetry
  leaves the machine only when an operator configures `PAPERCLIP_TELEMETRY_ENDPOINT`.
- `.github/workflows/commitperclip-review.yml` — upstream commitperclip bot
  workflow (PR review comments, quality gates) **disabled**: trigger reduced to
  `workflow_dispatch` only. It requires the upstream-only `COMMITPERCLIP_KEY`
  secret, targets upstream bot infrastructure, and uses `pull_request_target`
  with secret access — not applicable to this fork, and it can never succeed
  here. The Dependency Review capability it carried can be re-added to
  `supply-chain.yml` once the repository's Dependency graph is enabled.

## Migration numbering contract

Upstream owns migration numbers 0000–0499. Dopai-authored migrations start at
0500 (`0500_dopai_reserved.sql`). The 0500 journal entry must remain the
lexicographically last entry when merging upstream migrations.

## Supply-chain tooling (pinned)

| Tool | Pin | License | Use |
|---|---|---|---|
| anchore/syft | v1.50.0 | Apache-2.0 | SBOM (SPDX JSON) generation, local + CI |
| google/osv-scanner | v2.4.0 | Apache-2.0 | vulnerability scan of `pnpm-lock.yaml`, local + CI |
| postgres (OCI image) | `postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20` | PostgreSQL License | external database for the spike deployment |
| @anthropic-ai/claude-code | 2.1.220 | Anthropic Commercial Terms | AI engine candidate / smoke test (KC-02) |
| ccusage | 20.0.19 | MIT | per-seat usage reconciliation (KC-11) |

CI runs `.github/workflows/supply-chain.yml` on every push/PR: SBOM generation
and OSV scan with the pinned tool versions above. Scan evidence for Bước nền is
archived in the Dopaios repository under
`docs/architecture/verification/evidence/buoc-nen/`.

## OSV baseline (verification batch 1 correction)

The committed `pnpm-lock.yaml` had never been regenerated after the security
overrides were added, so the overridden versions (`undici`, `ws`, `vite@^6`)
were still resolved in the lockfile and the OSV gate could never pass on CI —
the clean re-scan recorded for Bước nền ran against a locally regenerated
lockfile that was not committed. Corrected in verification batch 1:

- Lockfile regenerated with `pnpm install --lockfile-only` (pnpm 9.15.4 via
  corepack) so all overrides take effect.
- Security overrides extended with same-major fixes only: `postcss 8.5.18`,
  `qs 6.15.2`, `react-router 7.18.0`, `hono 4.12.27`, `ip-address 10.1.1`,
  `js-yaml 4.3.0`, `path-to-regexp 8.4.0`, `@babel/core 7.29.6`,
  `better-auth 1.6.22`, `body-parser 2.3.0`, `brace-expansion 1.1.16 / 5.0.8`,
  `dompurify 3.4.12`, `fast-uri 3.1.4`, `form-data 4.0.6`, `esbuild 0.28.1`
  (for the `^0.27` instance).
- `osv-scanner.toml` records the accepted-risk baseline with reasons: packages
  whose only fix crosses a major/breaking boundary (`tar 6.2.1`,
  `@hono/node-server 1.19.13`, `@tootallnate/once 1.1.2`,
  `brace-expansion 1.1.16`, `esbuild 0.18.20`, `vite 7.3.1` — vitest-internal,
  and advisory `GHSA-qwww-vcr4-c8h2` on `react-router 7.18.0`) plus
  `@anthropic-ai/sdk 0.81.0`, owned by KC-02 (engine/adapter decision). New
  advisories against any other package still fail the gate. Review the whole
  baseline at the next upstream sync or before the architecture freeze.

## Dopai-authored fixture catalog (verification batch 1)

`dopaios/fixtures/` is authored by Dopai; it contains no third-party content.
It encodes the shared canonical fixture catalog (V-09) for verification batch 1
(KC-01, KC-03, KC-13, KC-14, KC-17). Normative sources are the approved Dopaios
governance artifacts pinned by git blob in `dopaios/fixtures/catalog.json`;
component files are pinned by SHA-256 over exact bytes (`.gitattributes`
disables EOL conversion in that directory). Consistency check:
`node dopaios/fixtures/validate.mjs`. The catalog record file lives in the
Dopaios repository under `docs/architecture/verification/evidence/fixtures/`.
