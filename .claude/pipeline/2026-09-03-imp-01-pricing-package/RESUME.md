# RESUME — PR-4 · imp-01 `@routeflow/pricing` (compiled package)

- **runId:** `wf_5a2757b3-a33`
- **scriptPath (staged engine, parallel copy):** `C:\ClaudeCode\routeflow\local-assets\tooling\pipeline-v3-c8.js` (`maxConcurrent 8`; otherwise identical to `pipeline-v3.js`)
- **Transcript dir:** `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\8d7999bc-726a-4431-9ad0-445d127f0188\subagents\workflows\wf_5a2757b3-a33`
- **Launched:** 2026-09-03 (`startedAt` 2026-09-03T14:12:33Z) from session `routeflow-19 [94ecf2]`
- **Worktree / branch:** `C:\ClaudeCode\routeflow\.claude\worktrees\rf-imp-04` · `refactor/imp-01-pricing-package` @ `e39bf9db` (master after PR #608)
- **Scale:** major · ui: false · loop: dev-pipeline · **runs in parallel with PR-2's engine** (main checkout)

Resume: `Workflow({ scriptPath, resumeFromRunId: "wf_5a2757b3-a33", args: <the exact object in the session's launch record> })`, with `workdir` = this worktree. Trust the run's `phaseReport`, never WIP diffs.

## Args (summary)

- artifact paths → this worktree's `.claude/pipeline/2026-09-03-imp-01-pricing-package/*.md`; `workdir` = the worktree
- testPackages: `tp-shape` (+ minimal package.json/jest.config.js scaffolding), `tp-golden`, `tp-no-mirrors`, `tp-runtime-imports` (extends the PR-1 spec; titles contain `@routeflow/pricing`)
- redGate: package specs fully; `no-runtime-workspace-imports.spec.ts -t "@routeflow/pricing"` — expect fail
- packages: `p1-package-skeleton` (opus) → `p2-sources` → `p3-tests-move`; `p1` → `p4-wiring` (opus, real `npm install`, lock-edge `missing 0`); `p2`+`p4` → `p5-rewrite` (codemod, deletes the 4 legacy files); all → `p6-docs`
- verify: perRound tsc + lint api; final `npm run verify`
- mutationProbe: `pricing.ts` → golden; `package.json` main → shape; mobile jest mapper → runtime-imports spec

## Landing order

Lands **after** PR-2 and PR-3 (item 2 completes before item 1 per the owner's list order). Before
its ship: JIT rebase onto `master` (expect import-line conflicts in `orders.service.ts` /
`orders.controller.ts` with PR-2/PR-3 — take both sides: the lock wrappers and the `@routeflow/pricing`
import), re-run the codemod `--check`, re-run gates, then the ship brief pattern (`pr-1-ship.md`),
subject ≤ 72 chars: `refactor: extract @routeflow/pricing, delete the three mirrors (imp-01)`.

## Close-out checklist (S8)

1. Coverage matrix R1–R9 → T1–T4 / A1–A5; quote red-gate, gate, mutation-probe results.
2. `result.json` → ledger append `--run imp-01-pricing-package --started 2026-09-03T14:12:33Z --ended <now>`.
3. Fable rulings → post-run fix round; gates: `rm -rf packages/pricing/dist && npm ci` → dist present; `npm run verify`; `local:up` (both images build — run from the MAIN checkout on the rebased branch, the stack is single); `local:validate:features`; mobile `npx tsc --noEmit`.
4. Opus refute-first review (money lens on the golden table + body-diff output) → SHIP.
5. Ship after PR-3; `docs/IMPROVEMENTS.md` row 1 → `shipped #<PR>`; memory + status page.
