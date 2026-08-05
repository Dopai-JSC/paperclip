# KC-10 verification harness

This directory contains the deterministic KC-10 dataset guards, browser workload,
accessibility matrix, independent percentile verifier, and Orca rehearsal used for
the Dopaios v1 architecture check. It is verification-only code and is disabled in
normal application builds.

## Safety and activation

Both gates are required:

- server: `DOPAIOS_KC10_ENABLED=true`;
- UI build: `VITE_DOPAIOS_KC10_ENABLED=true`.

The query parameter `kc10=1` selects a verification journey only when the UI gate
was enabled at build time. Without either gate, native routes remain active and the
verification API returns HTTP 404.

Do not use production data, production credentials, model calls, or a public app or
database endpoint. The approved topology is two dedicated AWS Lightsail Ubuntu
24.04 `xlarge_3_0` hosts: one private SUT and one private runner. A local workstation
is only an editor and coordinator.

## Required pins

- Paperclip base: `79c42d53aaef0d37532d35aa9565e0aaee346681`.
- Policy: `POL-NFR6-BROWSER-A11Y-001@1`, blob
  `74ce5de2fbebb18fdb10c72d0c130ff789144ffb`.
- Dataset: exactly 20 projects, 200 open SOP runs, 5,000 monthly work items,
  deterministic AI-session telemetry, 10 authenticated users, and manifest SHA-256.
- Browser packages and SHA-256 values are fail-closed in `kc10-lib.mjs`.

Runtime credentials are read from
`/opt/dopaios-kc10/secrets/runtime-seed.json`. Never print, copy into evidence, or
commit that file.

## Workload

Run warm-up separately from measurement:

```bash
KC10_PHASE=warmup \
KC10_RUN_ID=KC10-WARMUP-CHROME150-003 \
KC10_BROWSER_ID=chrome-150 \
KC10_BROWSER_PATH=/opt/dopaios-kc10/browsers/chrome-150.0.7871.187/chrome-linux64/chrome \
node scripts/kc10/browser-load.mjs

KC10_PHASE=measure \
KC10_RUN_ID=KC10-MEASURE-CHROME150-003 \
KC10_BROWSER_ID=chrome-150 \
KC10_BROWSER_PATH=/opt/dopaios-kc10/browsers/chrome-150.0.7871.187/chrome-linux64/chrome \
node scripts/kc10/browser-load.mjs

node scripts/kc10/verify-browser-run.mjs \
  /opt/dopaios-kc10/evidence/KC10-MEASURE-CHROME150-003
```

The measure guard refuses fewer than 10 users, 1,800 seconds, or 200 samples per
journey. Acceptance uses nearest-rank p95 of wall-clock navigation-to-usable time,
evaluates all five journeys independently, and fails on any request failure. The
run manifest hashes the served HTML and primary JavaScript asset as well as the
exact browser binary and package source.

## Accessibility

Invoke `browser-a11y.mjs` once for each pinned browser ID and matching executable:
`chrome-150`, `chrome-149`, `edge-150`, and `edge-149`. A run passes its automated
and keyboard portion only when all six audited screens have zero selected WCAG
violations and every recorded focus event is visibly focused.

The CDP accessibility tree is diagnostic evidence, not a screen-reader substitute.
The policy-required human screen-reader disposition remains
`pending-human-check` until a human operator signs it off. `run-orca-project-flow.sh`
is an AI-assisted real-Orca rehearsal; it deliberately requires speech output for a
Project-flow control and records `manualHumanSignoff: false`.

## Evidence integrity

Each run creates a new directory with exclusive file creation. Never reuse a run
ID, overwrite a failed directory, or delete failed evidence. After all probes,
generate a SHA-256 inventory outside the secret directory and independently verify
dataset counts, sample counts, p95 values, and worker lost/duplicate results.
