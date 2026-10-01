# Build plan — F12 (route delivery windows) — bug-pipeline, mode bugfix, scale small

Base master `12cdc26a`; worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-registry`; branch `fix/F12-route-windows`.
Design of record: `cause-ruling.md` §2. Tests of record: `bug-test-plan.md`. One PR (D6). Commits carry `Bookkeeping-Follow-Up: pending`.

## Packages

| id  | title                                                         | files                                                                                                                                       | effort | dependsOn | brief                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | start-time helper + ORS vehicle clock (B177)                  | `apps/api/src/route-optimization/route-optimization.service.ts`, `apps/api/src/route-optimization/route-analysis.service.ts`                | medium | —         | ruling §2: `resolveStartTime` helper (precedence lifted from analysis :243-247, used by both services); `callOrsOptimization(stops, depot, startTime)` sets `vehicleDef.time_window`; `WORKDAY_SEC` constant. Make T3 green; T6 pin green.                             |
| P2  | post-solve window pass + `windowViolations` (B147 + B161 API) | `apps/api/src/route-optimization/route-optimization.service.ts`                                                                             | high   | P1        | ruling §2: after every branch, `calculateETAs(order, startTime)` → deterministic repair (ascending `windowEnd` re-insert) → re-evaluate once → persist; `OptimizeResult.windowViolations` + `startTime`; `getRouteVariants` inherits. Make T1/T2 green; T5 pins green. |
| P3  | web: toast + both dispatch modals (B161 web)                  | `apps/web/lib/api/routes.ts`, `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx`, `apps/web/app/(dashboard)/routes/page.tsx`         | medium | P2        | ruling §2: `OptimizeResult` type gains `windowViolations`/`startTime`; toast count; late-stop warning + acknowledge in BOTH modals; `routes/page.tsx` modal sends `startTime`. Targeted edits only.                                                                    |
| P4  | B31 deletion                                                  | `apps/web/app/(dashboard)/routes/_components/CreateRouteModal.tsx`, `apps/web/app/(dashboard)/routes/_components/CreateRouteModal.test.tsx` | low    | —         | delete both files; nothing else.                                                                                                                                                                                                                                       |
| P5  | spec 35 + project                                             | `apps/web/e2e/35-route-windows.spec.ts`, `apps/web/playwright.config.ts`                                                                    | medium | P3        | T4 exactly; project `route-windows` (operator storageState, `dependencies:['setup']`) appended last. Never run Playwright locally.                                                                                                                                     |

Non-goals: B29 (feature — deferred, D5); mobile window rendering (file a row); deleting `InstallAppButton`/`ReportChart` (file a row); changing `solveOrder`/`buildCostMatrices`; any migration.

## Test packages (authored BEFORE implementation)

| id     | files                                                                                                                                  | tests          | effort | brief                                                              |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ | ------------------------------------------------------------------ |
| TP-API | `apps/api/src/route-optimization/route-optimization.service.spec.ts`, `apps/api/src/route-optimization/route-analysis.service.spec.ts` | T1 T2 T3 T5 T6 | high   | `bug-test-plan.md` exactly incl. Harness notes; implement nothing. |
| TP-E2E | `apps/web/e2e/35-route-windows.spec.ts`, `apps/web/playwright.config.ts`                                                               | T4             | medium | T4 exactly; project entry mandatory; outside the local red gate.   |

## Gates

- Red gate: `cd apps/api && npx jest src/route-optimization --runInBand -t "REG-B(147|161|177)"` → fails today on the plan's values.
- perRound: `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` · `cd apps/api && npx jest src/route-optimization src/routes --runInBand` · `cd apps/web && npx tsc --noEmit -p tsconfig.json`
- final: `cd apps/api && npx jest --silent` · `cd apps/web && npx jest --silent` · `node scripts/validate-lessons.mjs`
- Probe (revert-fix): `route-optimization.service.ts` → REG-B147.

## Manual verification

| Token   | What was checked by hand                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| REG-B31 | `CreateRouteModal.tsx` + `.test.tsx` deleted; `git grep CreateRouteModal` empty outside `docs/audit`; web tsc + jest green |

## Pipeline args

See `pipeline-args.json`.
