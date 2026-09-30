# Fix ruling — F12 (B147 · B161 · B177 + B31 deletion; B29 deferred) route delivery windows

> Fable @ high, 2026-09-06, over `cause-brief.md` (S1) and `refutation.md` (S2) in this dir (pre-planned read-only against
> master 12cdc26a). Worktree `rf-registry`, branch `fix/F12-route-windows`. Batch is AGENT-SAFE (owner's blanket go
> for the backlog, 2026-09-06). One PR (D6).

## 1. Cause verdicts (from S2, all confirmed on 12cdc26a)

| Bug  | Verdict                        | Diverging line                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B147 | confirmed                      | `route-optimization.service.ts:657` — `solveWithCostMatrix` reduces stops to `LatLng[]`; windows selected (`:263-267`), mapped (`:325-326`), then dropped; `solveOrder` is cost-only. Branch condition is `apiKey && depot/start` (`:356`, `:519`). Register's "prefer ORS" fix REFUTED (ORS is clock-less, B177).                                                                                |
| B161 | confirmed, wider               | `OptimizeResult` (`:51-56`) carries no window field; `createRun` has no feasibility gate; `DispatchModal` (`templates/[id]/page.tsx:282-290`) never receives the analysis; a SECOND `DispatchModal` at `routes/page.tsx:71-79` sends no `startTime`; `calculateETAs` is pure and AI-independent (`route-analysis.service.ts:91-105`). Audit's FILE_NOT_FOUND = frontmatter omission, lines exact. |
| B177 | confirmed                      | `callOrsOptimization(stops, depot)` `:1052-1055`; `vehicleDef` `:1059-1070` has no `time_window`; job windows are absolute seconds-from-midnight (`timeToSec` `:36-39`); start-time precedence exists only in `route-analysis.service.ts:243-247`.                                                                                                                                                |
| B31  | confirmed dead code            | `CreateRouteModal.tsx` referenced only by its own test; live create flow is `routes/create/page.tsx`.                                                                                                                                                                                                                                                                                             |
| B29  | confirmed, FEATURE-SHAPED (D5) | a working `PATCH /settings/route` with no screen; one of 34 orphaned hooks. **Deferred** — not built here.                                                                                                                                                                                                                                                                                        |

## 2. Fix design (minimal diff; one invariant, three branches)

- **Start time, once:** `resolveStartTime(run?, route?)` helper (run `startTime` → route `defaultStartTime` → `"08:00"`), lifted from `route-analysis.service.ts:243-247` and used by optimize AND analyze (B177's invariant: the solver's clock equals the ETA pass's clock).
- **Post-solve window pass at the shared seam:** in `optimizeTemplate`/`optimizeRoute` after ANY branch (Google cost-matrix, ORS, nearest-neighbour) returns an order and BEFORE persisting: run `calculateETAs(order, startTime)`; if any windowed stop violates its window, apply a deterministic repair (stable re-insert of violating windowed stops in ascending `windowEnd` at the earliest position that keeps them feasible; unwindowed stops keep cost order) and re-evaluate once; persist the result; `OptimizeResult` gains `windowViolations: Array<{ stopId, eta, windowStart, windowEnd }>` (empty when feasible) and `startTime`. `getRouteVariants` inherits the pass (same seam).
- **ORS (B177):** `callOrsOptimization(stops, depot, startTime)` sets `vehicleDef.time_window = [timeToSec(startTime), timeToSec(startTime) + WORKDAY_SEC]` (`WORKDAY_SEC` = 12 h constant with a comment); job windows unchanged.
- **Web (B161):** optimize toast reads "Route optimized" or "Route optimized — N stop(s) miss their window" from `windowViolations`; BOTH dispatch modals (`templates/[id]/page.tsx`, `routes/page.tsx`) show a late-stop warning list derived from the last optimize result (or `useAnalyzeRoute` at open when none), requiring an explicit acknowledge before "Dispatch"; `routes/page.tsx`'s modal also sends `startTime` (default from `useRouteSettings`).
- **B31:** delete `apps/web/app/(dashboard)/routes/_components/CreateRouteModal.tsx` and its `.test.tsx`. Siblings `components/InstallAppButton.tsx` / `components/ReportChart.tsx` are FILED (new hygiene registry row), not deleted here.
- **Must NOT change:** `solveOrder`'s pure 2-opt contract and its existing tests; `buildCostMatrices`; the `/analyze` endpoint's shape; mobile (file a row: mobile never renders `withinWindow`); ad-hoc trips share the endpoints and inherit the fix without edits.
- **Invariant:** for any stop set where a window-feasible order exists, the persisted order is window-feasible against the real departure clock on every branch; where none exists, `windowViolations` names the stops.

## 3. Regression tests — `bug-test-plan.md` (T1–T6). REG tokens `REG-B147`, `REG-B161`, `REG-B177`, `REG-B31` (T3 row: build-plan manual-verification row).

## 4. Blast radius (`radiusFiles`, read-only neighbours)

`apps/api/src/route-optimization/route-analysis.service.ts`, `apps/api/src/route-optimization/cost-matrix.ts`, `apps/api/src/routes/routes.service.ts` (read: `createRun`), `apps/web/lib/api/routes.ts`.

## 5. Sibling patterns

- `points: LatLng\[\] = \[` — a window-blind reduction of stops before a solver.
- `defaultStartTime \?\?` — a hand-rolled start-time precedence copy (must use the helper).
- `useOptimize(Template|RouteRun)` — optimize callers that never consult the window signal (mobile: file, don't fix).

## 6. Data repair

None persisted-wrong: previously optimized orders may be window-infeasible but are re-optimizable by the operator; no script.

## 7. Probe plan (`revertFix: true`)

| File                                                            | REG test that must go red |
| --------------------------------------------------------------- | ------------------------- |
| `apps/api/src/route-optimization/route-optimization.service.ts` | REG-B147 (T1)             |

## 8. Close-out bindings

Registry: `prove` B147/B161/B177 (T1) + B161's T2 row `--pending-deploy`; B31 T3 `prove --build-plan`; B29 → `move`/note as deferred feature (D5) — owner decision at the next review. New rows to file: mobile optimize-without-analyze (window signal absent), orphaned components InstallAppButton/ReportChart, orphaned-hook class (34 hooks; a lint guard). Lesson (archive TWO; id from `nextId`) + code map in the docs follow-up. Spec number for the T2: **35** (`35-route-windows.spec.ts`; 33 = F18, 29 = F08, 34 taken).
