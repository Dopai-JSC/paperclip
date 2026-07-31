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

## message-db blueprint copy (KC-01)

| Field | Value |
|---|---|
| Upstream | https://github.com/message-db/message-db |
| Pin | commit `25da82b044f94416202ac3daa1866791b385badc` (default-branch HEAD at copy time; nearest tag v1.3.0 = `e6999a6bd95`) |
| Copied | 2026-07-31, verbatim `database/` + `MIT-License.txt` + `VERSION.txt` into `dopaios/message-db/` |
| License | MIT |
| Role | Reference blueprint for the KC-01 event store (verification plan Appendix A, option B: copy schema/functions into the repo and own migrations, upstream dormant) |

Ownership rule: Dopaios schema/function changes are made only through
Dopai-authored migrations (0500+ region); `dopaios/message-db/` stays a pristine
upstream snapshot for comparison. See `dopaios/message-db/PIN.md`.

## Dopai-authored fixture catalog (verification batch 1)

`dopaios/fixtures/` is authored by Dopai; it contains no third-party content.
It encodes the shared canonical fixture catalog (V-09) for verification batch 1
(KC-01, KC-03, KC-13, KC-14, KC-17). Normative sources are the approved Dopaios
governance artifacts pinned by git blob in `dopaios/fixtures/catalog.json`;
component files are pinned by SHA-256 over exact bytes (`.gitattributes`
disables EOL conversion in that directory). Consistency check:
`node dopaios/fixtures/validate.mjs`. The catalog record file lives in the
Dopaios repository under `docs/architecture/verification/evidence/fixtures/`.
