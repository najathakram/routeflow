# Handoff — 2026-09-11 · 2026-09-11-google-signin-monitor

- Task: Google sign-in monitor (DECIDE-29 / OPS-23), dev-pipeline small run `wf_be295278-049`
- State: IMPLEMENTED + light-loop round 1 (Opus review → Fable D1–D5) applied and committed
- Branch/tree: `feat/google-signin-monitor` in `.claude/worktrees/rf-smoke`, off `70d15a87`
- Run dir: `.claude/pipeline/2026-09-11-google-signin-monitor/` · result.json + ledger row
  (trueCostUsd $26.23) + RUN-LOG entry all landed
- Round 1 corrections (see build-plan.md "Post-implementation corrections"):
  - D1 URL-first classification, `decodeAuthError` (prod error page is ~773 KB, marker only ~700 KB in)
  - D2 `ok` needs a positive sign-in signal, else `unexpected_page`; `access_denied` markers added
  - D3 Google/Apex sections hoisted ABOVE post-deploy-check's login gate (sections 2/3)
  - D4 callers log `finalPage` (origin+pathname) only — never the consent query string
  - D5 runbook dated by DISCOVERY 2026-09-11, restore steps + Limits + red-run table; workflow drops setup-node
- Gates: self-test 117 checks / exit 0 · `bugs.mjs self-test` green · `node --check` ×5 · prettier clean ·
  M1 local smoke + post-deploy-check exit 0 · PROD ORACLE exits 1 with both doors `deleted_client`
- Next: owner rebuilds the OAuth brand + Web client (runbook §"Restoring the client"), then
  `npm run smoke:google` against prod must go green. Push/PR not done — nothing pushed yet.
- Do not: push or flip visibility without the coordinator; do not re-run closeout (idempotent by slug).
