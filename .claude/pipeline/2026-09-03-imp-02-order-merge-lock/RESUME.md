# RESUME — PR-2 · imp-02 customer advisory lock for order merges

- **runId:** `wf_cad52fe2-0ce`
- **scriptPath (staged engine):** `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v3.js`
- **Transcript dir:** `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\8d7999bc-726a-4431-9ad0-445d127f0188\subagents\workflows\wf_cad52fe2-0ce`
- **Launched:** 2026-09-03 (`startedAt` 2026-09-03T12:50:55Z) from session `routeflow-19 [94ecf2]`
- **Branch:** `fix/imp-02-order-merge-advisory-lock` @ `e39bf9db` (master after PR #608), main checkout
- **Scale:** major · ui: false · loop: dev-pipeline

Resume: `Workflow({ scriptPath, resumeFromRunId: "wf_cad52fe2-0ce", args: <the exact object in the session's Workflow launch record> })`.
On resume trust the run's own `phaseReport`, never WIP diffs in the tree.

## Args (summary — the byte-exact object is in the launch record)

- planPath/discoveryPath/specPath/testPlanPath → `.claude/pipeline/2026-09-03-imp-02-order-merge-lock/*.md`; lessonsPath `.claude/lessons/LESSONS.md`
- testPackages: `tp-db-locks` (high), `tp-controller` (high, adds 4 `it` to `orders.scan-hardening.spec.ts`), `tp-service` (high, `orders.merge-lock.spec.ts`), `tp-db-lane` (`db-locks.db.spec.ts`, lane-only)
- redGate: `db-locks.spec.ts` + `orders.merge-lock.spec.ts` fully; `orders.scan-hardening.spec.ts -t "advisory lock|MERGE_IN_PROGRESS|no in-process lock|LockUnavailable"` — expect fail
- packages: `p1-db-locks` (opus/high) → `p2-controller` (opus/high) · `p3-service` (opus/high) → `p4-config-docs` (low; L-054, IMPROVEMENTS rows 2/3, spec.md pipe escape) · `p5-pr1-followups` (test-only carry-overs)
- verify: perRound tsc + lint api; final `npm run verify`
- mutationProbe: db-locks.ts → T1; orders.controller.ts → T2; orders.service.ts → T3

## Close-out checklist (S8)

1. Coverage matrix R1–R7 → T1–T4 / A1–A4; quote red-gate, gate, mutation-probe results.
2. `result.json` → ledger append `--run imp-02-order-merge-lock --started 2026-09-03T12:50:55Z --ended <now>`.
3. Fable rulings on remaining findings/deferrals → post-run fix round (Opus code / Sonnet record).
4. Gates on the fixed tree: `cd apps/api && npx jest --ci`; mobile jest; `npm run verify`; `npm run local:test:db` (T4 + PR-1 lane); `npm run local:validate:features`; contention script A3 against the local stack.
5. Opus refute-first review of the post-run diff → SHIP.
6. Ship via `scratchpad/ship-briefs/pr-2-ship.md`; post-deploy check with the script's DEFAULT tenant; prod drift check (no schema change — informational).
7. `docs/IMPROVEMENTS.md` row 2 → `shipped #<PR>` (carried by PR-3's docs package); memory note; then PR-3 prep.
