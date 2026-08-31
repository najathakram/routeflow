# F12 · Route optimization and delivery windows

**Bug IDs (5):** B29, B31, B147, B161, B177

**Root cause:** With a Google Maps key set (the deployed norm), both optimize paths take the cost-matrix branch, which never reads delivery windows (B147), and the only feasibility check is wired to an optional Analyze button (B161). Plus the uneditable route settings (B29) and dead CreateRouteModal (B31).

**Ships as:** One PR.

**Files:** route-optimization.service.ts · web routes/templates pages

**Together because:** One optimization service missing window-awareness on its primary path, plus two smaller dead-UI web bugs riding along (B29's fix is wiring the already-implemented useUpdateRouteSettings hook into the settings UI; B31 is dead-code removal).

**Guardrails / shared infra:** None new. Consumes G7's extracted lineItems const.

**Dependencies / lane notes:** Requires F05 (semantic, consumes G7's const).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F12.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B29  | T2   | 2d0270fd       | AMBIGUOUS_FILE (corrected)   |
| B31  | T3   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B147 | T1   | 0b2c3a0a       | MOVED (disambiguate in-file) |
| B161 | T1   | 0b2c3a0a       | FILE_NOT_FOUND               |
| B177 | T1   | 0b2c3a0a       | OUT_OF_BOUNDS (corrected)    |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B29 — Route settings exist but can’t be edited

**Area:** Routes · web + API

**Meant to do:** Ops should be able to tune per-tenant route-planning defaults (avg speed, per-stop service time, default dispatch start time, depot) from a settings screen.

**Actually does:** Values live server-side and are read read-only (useRouteSettings) into route-create/detail/dispatch/template-analysis screens as defaults; useUpdateRouteSettings (PATCH /settings/route) is defined but called from nowhere.

**The gap:** No screen exposes averageSpeedKmh/serviceTimeMinutes/defaultStartTime for editing; tenants are stuck on whatever value the API/DB currently holds.

**Evidence:** apps/web/lib/api/routes.ts:~707 [re-anchored master@6c8f1401; was :658-684 at hunt round master@2d0270fd] (RouteSettings, useRouteSettings, useUpdateRouteSettings); read-only consumers at routes/create/page.tsx:209, routes/[id]/page.tsx:372, routes/templates/[id]/page.tsx:296,304-307,403,952 (defaultStartTime in Analysis tab), deliveries/new/page.tsx:153; repo-wide grep for `useUpdateRouteSettings` returns only its own definition (plus a docs/web-inventory mention, not a call site). API side (settings.controller.ts, update-route-settings.dto.ts) confirms the endpoint is real and only server-consumed.

**Suggested fix:** Add a "Route planning" settings form (e.g. in the Settings hub or a routes-page dialog) bound to useUpdateRouteSettings so ops can edit avg speed/service time/default start time/depot; otherwise remove the unused mutation.

### B31 — CreateRouteModal is dead code

**Area:** Routes · web

**Meant to do:** N/A (dead-code claim) — the routes-create flow should have exactly one live implementation.

**Actually does:** CreateRouteModal.tsx (260 lines, full modal with its own form/map wiring) is never imported anywhere in apps/web; routes/page.tsx imports EditRunModal from the same _components directory but not CreateRouteModal, and the live create flow is routes/create/page.tsx.

**The gap:** Dead component shipped in the bundle with zero consumers, doing nothing.

**Evidence:** Repo-wide grep for `CreateRouteModal` returns only its own definition (apps/web/app/(dashboard)/routes/_components/CreateRouteModal.tsx:35,40); apps/web/app/(dashboard)/routes/page.tsx:30 imports EditRunModal, not CreateRouteModal.

**Suggested fix:** Delete apps/web/app/(dashboard)/routes/_components/CreateRouteModal.tsx.

### B147 — Delivery windows are silently ignored whenever a Google Maps key is configured

**Area:** Route optimization · API + web

**Meant to do:** The customer page states plainly that "the route optimizer will schedule this stop within the window", so operators expect Optimize to respect the hours they set.

**Actually does:** With GOOGLE_MAPS_API_KEY set — the deployed norm — both optimize paths take the cost-matrix branch, which never reads deliveryWindowStart/End. The toast still reads a plain "Route optimized".

**The gap:** Engine selection keys on the Google key plus a start point and never on whether windows exist, so the only window-aware solver is bypassed exactly where it matters.

**Evidence:** apps/api/src/route-optimization/route-optimization.service.ts:354-377 (optimizeTemplate: if (apiKey && depot) → solveWithCostMatrix, else ORS), :516-540 (optimizeRoute, same branch), :589-632 and :636-690 (solveOrder + solveWithCostMatrix — nearest-neighbour plus 2-opt, zero window inputs), :1052-1080 (callOrsOptimization is the only builder of time_windows); the nearest-neighbour fallback ignores windows too; apps/web/app/(dashboard)/customers/[id]/page.tsx:2815-2818 (the promise); apps/web/app/(dashboard)/routes/templates/[id]/page.tsx:515-521 (identical success toast either way); apps/web/app/(dashboard)/routes/[id]/page.tsx:584-586 (an ORS_NOT_CONFIGURED hint that tells the operator to set a key for the branch that is not running).

**Suggested fix:** Prefer the ORS path (or add window handling to solveOrder as an ordering penalty or feasibility check) whenever any stop in the set carries a delivery window and ORS is configured; failing that, surface a "delivery windows were not enforced" notice on the optimize result instead of a plain success toast.

### B161 — The window-violation check gates nothing — Optimize and Dispatch never consult it

**Area:** Route optimization · web + API

**Meant to do:** When an operator optimizes and dispatches a route, an infeasible plan — stops that cannot be reached inside their customers' delivery windows — is flagged somewhere in that flow before the run goes out.

**Actually does:** Window feasibility is computed only by the separate, optional "Analyze Route" button. The optimize success toast carries no window data and the dispatch modal receives no analysis at all, so a knowingly-late run dispatches silently.

**The gap:** The only code that evaluates delivery windows is wired to an optional button, disconnected from both the success signal and the dispatch action.

**Evidence:** apps/api/src/route-optimization/route-optimization.service.ts:193-235 (calculateETAs/withinWindow); grep for calculateETAs across apps/ returns exactly two callers, both behind the /analyze endpoint (route-analysis.service.ts:92 and :270); apps/web/app/(dashboard)/routes/templates/[id]/page.tsx:406, :500-528 (the toast reports only fallback usage and reordered count), :959-973 (the Analyze button), :281-327 (the dispatch modal's props and payload carry no analysis).

**Suggested fix:** Have the optimize endpoints return the ETA/window evaluation alongside the stop order and surface any late stops in the optimize toast, and pass the same evaluation into the dispatch modal so dispatch shows — or requires acknowledging — known violations.

### B177 — The ORS optimizer is given no start time or vehicle window, so its "hard constraint" is untethered

**Area:** Route optimization · API

**Meant to do:** When the solver treats delivery windows as a hard constraint, the stop order it returns is deliverable within every window given the real departure time the route will actually run at.

**Actually does:** The ORS call takes no start time and the vehicle definition carries no time window, so the solver evaluates seconds-from-midnight job windows against an implicit zero clock rather than the run's real departure.

**The gap:** Job windows are absolute time-of-day while the vehicle's clock is unbounded, so a "feasible" order is never checked against the time the driver actually leaves.

**Evidence:** apps/api/src/route-optimization/route-optimization.service.ts:1052-1107 (the call takes stops and depot only), :1059-1070 [re-anchored: route-optimization.service.ts now ~L1078 on master@6c8f1401; was :1059-1070 at hunt round master@0b2c3a0a] (the vehicle definition has no time_window), :1078 and :37 (job windows built as seconds from midnight), :193-235 (the only start-time-aware evaluation, whose sole callers are the analysis service); reachability: :355-376 (the ORS branch runs only when no Google key or no resolvable depot) and configuration.ts:144 (an unset ORS key makes the call throw straight through to a nearest-neighbour fallback that reads no windows at all).

**Suggested fix:** Pass the route's default start time (or the run's dispatched start time) into the ORS call as the vehicle's time-window lower bound so the solver works against the real departure clock, and re-validate the returned order with the ETA pass before reporting success.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
