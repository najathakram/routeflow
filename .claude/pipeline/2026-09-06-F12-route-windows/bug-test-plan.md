# Bug test plan — F12 (route delivery windows)

> Fable @ high from `cause-ruling.md`; Sonnet types the tests inside the engine. Behavioral red bar: each REG test
> fails TODAY on its own exact wrong value. Harness: `route-optimization.service.spec.ts:10-31` (`createMockPrisma`,
> `ConfigService.get` jest mock, `SystemConfigService` mock); mock `global.fetch` to REJECT for the Google branch so
> `buildCostMatrices` returns the deterministic haversine matrix (never cached, `cost-matrix.ts:30-33`).

## Red set (REG-tagged; in the red gate)

| T#  | Title                                                                        | Setup                                                                                                                                                                                                                                                                                  | Asserts                                                                                                                                                                                                                                                                                                                                   | Fails TODAY with                                                                   | File                                                                 |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| T1  | REG-B147 optimize persists a window-feasible order on the cost-matrix branch | `configGet('googleMaps.apiKey') → 'test-key'`; route with a depot + three geocoded stops where the pure-cost optimum is `[near, mid, far]` and only `far` has `deliveryWindowStart/End = "08:00"/"09:00"`; start time `"08:00"` from the mocked `SystemConfigService`; `fetch` rejects | `result.stopOrder[0].stopId === 'stop-far'`; the LAST `stopNumber` persisted per stop id reproduces `result.stopOrder` (harness-shape-agnostic); re-running the real `calculateETAs` over that persisted order leaves NO windowed stop late (the invariant is window-feasibility, not one permutation); `result.windowViolations` is `[]` | `stopOrder[0].stopId` is `'stop-near'` (expected 'stop-far', received 'stop-near') | `apps/api/src/route-optimization/route-optimization.service.spec.ts` |
| T2  | REG-B161 optimize reports the stops that miss their window                   | same harness; a stop whose window closes before its reachable ETA under any order                                                                                                                                                                                                      | `result.windowViolations` contains `{ stopId, eta, windowEnd }` for that stop; `result.startTime === "08:00"`                                                                                                                                                                                                                             | `result.windowViolations` is `undefined`                                           | same                                                                 |
| T3  | REG-B177 the ORS request carries the vehicle clock                           | `configGet('googleMaps.apiKey') → undefined`, `configGet('ors.apiKey') → 'ors-key'`; `fetch` resolves a valid `{routes:[{steps:[...]}]}`; start time `"08:00"` as DATA from the mocked settings (never the host clock, L-047)                                                          | `JSON.parse(fetch.mock.calls[0][1].body).vehicles[0].time_window` equals `[timeToSec("08:00"), timeToSec("08:00") + WORKDAY_SEC]`                                                                                                                                                                                                         | `vehicles[0].time_window` is `undefined`                                           | same                                                                 |

## Pending-deploy proofs (outside the red gate)

Playwright cannot run in the local red gate (no deployed/compose target is provisioned for it, and the
spec provisions customers through `POST /customers`, which needs working geocoding for stop coordinates —
without it T4 would fail as a fixture/ERROR-class failure rather than on behaviour). T4 is therefore
authored, collected (`npx playwright test --list --project=route-windows`) and run post-deploy, not inside
the gate. It is NOT part of the gate's denominator.

| T#  | Title                                                           | Setup                                                                                                                                                | Asserts                                                                                                                                                                                    | Fails TODAY with                     | File                                                                                                                  |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| T4  | REG-B161 dispatch modal warns about late stops (T2, Playwright) | `test` tenant; a template route with one windowed stop that the persisted order misses (built via API); open the template page → Optimize → Dispatch | the modal shows the late-stop warning (assert through the dialog role) and "Dispatch" requires the acknowledge; the optimize toast names the count (assert via the toast container, L-076) | no warning element (getByRole fails) | `apps/web/e2e/35-route-windows.spec.ts` + `playwright.config.ts` project `route-windows` (OUTSIDE the local red gate) |

## Pins (no REG token; outside the red gate)

| T#  | Frozen behavior                                                                                                                     | File                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| T5  | `solveOrder` pure tests, `dedupeVariants`, `applyTollContrast`, `getRouteVariants`, `applyRouteVariant` unchanged                   | route-optimization.service.spec.ts |
| T6  | `analyzeRoute` returns `configured:false` without an AI key and its ETA pass runs on the clock the SAME `resolveStartTime` returned | route-analysis.service.spec.ts     |

> **T6 amendment (red-gate remediation, 2026-09-06):** T6 is retitled `REG-B177: …` so the red-gate `-t` filter
> collects it (it was silently skipped as `T6: …`), and its oracle is the third `calculateETAs` argument — the mocked
> helper returns `"06:45"`, deliberately not the `"08:00"` analyze inlines today, so it fails on a distinguishing
> value. T6 is therefore INSIDE the red gate; T5 remains a pin outside it.

## Manual verification (T3 row)

| Token   | What was checked by hand                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REG-B31 | `CreateRouteModal.tsx` and `CreateRouteModal.test.tsx` deleted; `git grep CreateRouteModal` returns nothing outside `docs/audit`; web typecheck + jest green |

## Harness notes

- Every existing stop fixture sets `deliveryWindowStart/End: null` — new fixtures carry real `"HH:mm"` strings; `mockRoute()` (`:215-252`) is the base.
- `route-analysis.service.spec.ts` mocks `calculateETAs` outright (result-injecting mock, L-081 hazard) — the new optimize tests use the REAL `calculateETAs`; do not add the analysis mock to them.
- `matrixCache` (`cost-matrix.ts:43`) leaks between tests only for real Google matrices — the haversine path is uncached; a test that mocks a Google matrix must use unique coordinates.
- Web: the `routes/page.tsx` `DispatchModal` is a second, duplicated component — both modals change in P4; no web unit runner exists (D1), so the modal behaviour is T2 (spec 35) and the API half is the T1 proof.

## Commands

- `redGate.commands`: `cd apps/api && npx jest src/route-optimization --runInBand -t "REG-B(147|161|177)"` → expect fail today.
  **The gate's denominator is the four `apps/api` jest tests T1, T2, T3 and T6** — that command is the only
  red-gate command. T4 is a pending-deploy Playwright proof (see the table above) and is deliberately not
  counted by the gate; T5 is a pin.
- Registry proof lines: REG-B147 (T1), REG-B161 (T1 + T2 row pending-deploy), REG-B177 (T3 + T6), REG-B31 (T3 manual row above).
