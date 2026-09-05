# Cause ruling — E2E freshness guard skips every run (Fable, 2026-09-04)

1. Cause verdict — ACCEPTED, both halves (S2 confirmed by execution).
   H1: `.github/workflows/ci.yml` e2e job, step "Skip superseded deployments", line ~402: `latest=$(gh api … --jq '.[0].sha' 2>/dev/null || true)` conflates "sha" / "no deployments" / "HTTP error": on a 4xx `gh api` writes the error JSON to STDOUT, exits 1, `--jq` is not applied; `|| true` masks the exit and `2>/dev/null` the message; line ~403 `[ -z "$latest" ]` tests emptiness, not success, so the intended fail-open branch is unreachable and the sha comparison yields `run=false` for every event.
   H2: the run token has NO `deployments` permission (restricted default = contents+packages read only; ci.yml declares no `permissions:`). The deployments list is public data while the repo is public, so the guard worked only inside a public window; the short-window discipline (2026-09-04) exposed it. Two shipped commits lack a post-deploy E2E: e39bf9db (#608) and f60bd27c (#609); the fix's own deploy discharges both (f60bd27c ⊃ e39bf9db).

2. Fix design (minimal diff).
   a) `.github/workflows/ci.yml`, e2e JOB (not workflow) level: `permissions: { contents: read, deployments: read }` with a two-line comment citing the restricted-default rule. The verify job is NOT touched (a workflow-level block would narrow the merge gate).
   b) The guard's logic moves out of inline bash into `scripts/ci-freshness-guard.mjs` (node, no deps; the repo's CI-script convention — see `scripts/ci-audit-critical.mjs`). Env contract: `DEPLOY_SHA` (required), `GITHUB_REPOSITORY` (required), `GITHUB_OUTPUT` (path; the script appends `run=true|false`), `CI_FRESHNESS_GH_CMD` (test-only JSON argv override for the `gh` call), `CI_FRESHNESS_GH_TIMEOUT_MS` (default 30000). It runs `gh api repos/<repo>/deployments?per_page=1` via `spawnSync` (`shell:false`, no `--jq`), then decides:
   (A) exit 0 AND stdout parses as a JSON ARRAY with `[0].sha` a string → compare to DEPLOY_SHA → `run=true` (+ `::notice::newest deployment <sha> matches`) or `run=false` (+ `::notice::Skipping — deployment <DEPLOY_SHA> is superseded by <sha>`).
   (B) exit 0 AND an empty array → `run=true` + `::notice::no deployments recorded — proceeding`.
   (C) exit ≠ 0, OR stdout is not a JSON array (an error object, invalid JSON, a timeout) → `run=true` + `::warning::Could not read the newest deployment (<reason: exit code + first 200 chars of the body/stderr>) — proceeding rather than skipping`.
   The script ALWAYS exits 0 (fail-open is the contract; a red guard step would hide the suite exactly like a skip). It never prints secrets.
   c) The ci.yml step's `run:` becomes `node scripts/ci-freshness-guard.mjs` with the same env (`DEPLOY_SHA: ${{ github.event.deployment.sha }}`, `GH_TOKEN`), keeping the step id `freshness` and its output name `run` so the seven consumers are untouched; the step comment is rewritten to state the fail-open contract and the permission it needs.
   d) Must NOT change: the readiness gate, every `steps.freshness.outputs.run == 'true'` consumer, the verify job, the tip-comparison alternative (recorded as a follow-on: a permission-free fallback that would regress docs-only merges — not built).
   Invariant: an error reading the newest deployment NEVER skips the suite; a genuinely superseded deployment (newest sha ≠ event sha) still skips.

3. Regression tests — see bug-test-plan.md. REG token: `REG-E2EGUARD-403`.

4. Blast radius (radiusFiles): `.github/workflows/ci.yml`, `scripts/ci-freshness-guard.mjs`, `apps/api/src/common/ci-freshness-guard-script.spec.ts`, `scripts/ci-audit-critical.mjs` (pattern sibling, read-only).

5. Sibling pattern: `gh api[^\n]*\|\| true` and `2>/dev/null \|\| true\)` captures of `gh` — S2 grep found exactly one instance (this one) in `.github/workflows/**` and none in `scripts/**`; the four `curl -w '%{http_code}' || true` captures are safe by construction (they capture the status code, not a body). Recorded: none plausible beyond the fixed site.

6. Data repair: none (no persisted data). Coverage repair: the first deploy after this fix must show the guard printing a real sha and the Playwright steps executing; that run discharges #608 and #609's missing post-deploy E2E.

7. Probe plan: `.github/workflows/ci.yml` gets `revertFix: true` (restore master's inline guard step) — T1 (`REG-E2EGUARD-403`, YAML-driven) must go red; `scripts/ci-freshness-guard.mjs` gets a mutation probe (ignore the exit status / treat the error object as data) — T2 must go red.
