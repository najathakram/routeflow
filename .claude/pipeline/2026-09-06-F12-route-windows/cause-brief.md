# Cause brief — F12 B29 B31 B147 B161 B177

Batch F12 (board #525) is route optimization / delivery windows. No committed plan exists yet.
Registry records are all `_Not yet analysed._` beyond the imported "Reported evidence" from the
original hunt; this brief re-verifies each citation against the current tree (master, working
tree as checked out — no `git rev-parse HEAD` capture requested by the role, all reads via
`git -C C:/ClaudeCode/routeflow`).

Grouping (per the verifier's note in the brief): B147 + B161 + B177 are three angles on ONE
mechanism in `route-optimization.service.ts` — the optimize path never consults delivery windows,
under three different lenses (engine selection, wiring of the one window-aware check, and the ORS
solver's own clock). B29 + B31 are unrelated dead-UI findings in `routes.ts` / `CreateRouteModal.tsx`.

## The bug as stated

### B147 — Delivery windows silently ignored whenever a Google Maps key is configured

**Source (verbatim).** "With GOOGLE_MAPS_API_KEY set — the deployed norm — both optimize paths
take the cost-matrix branch, which never reads deliveryWindowStart/End. The toast still reads a
plain 'Route optimized'." — "Engine selection keys on the Google key plus a start point and never
on whether windows exist, so the only window-aware solver is bypassed exactly where it matters."

**Repro.** Input: a route/template with a Google Maps API key configured, a resolvable depot, and
≥1 stop carrying `deliveryWindowStart`/`deliveryWindowEnd` → observed: `optimizeTemplate`/
`optimizeRoute` take the `solveWithCostMatrix` branch, which receives only `{lat,lng}` points and
an optimizeBy/avoidTolls metric — no window field anywhere in its signature or body — and the
success toast reads plain "Route optimized" with no window caveat; expected: the window-aware path
(or a window-respecting ordering) runs, or the UI discloses that windows were not enforced.

**Suspected cause (claim, quoted).** "Evidence · apps/api/src/route-optimization/route-optimization.service.ts:354-377
(optimizeTemplate: if (apiKey && depot) → solveWithCostMatrix, else ORS), :516-540 (optimizeRoute,
same branch), :589-632 and :636-690 (solveOrder + solveWithCostMatrix — nearest-neighbour plus
2-opt, zero window inputs), :1052-1080 (callOrsOptimization is the only builder of time_windows)."

### B161 — The window-violation check gates nothing — Optimize and Dispatch never consult it

**Source (verbatim).** "Window feasibility is computed only by the separate, optional 'Analyze
Route' button. The optimize success toast carries no window data and the dispatch modal receives
no analysis at all, so a knowingly-late run dispatches silently." — "The only code that evaluates
delivery windows is wired to an optional button, disconnected from both the success signal and the
dispatch action."

**Repro.** Input: operator optimizes a route with a window-violating stop order, then opens the
dispatch modal without first clicking "Analyze Route" → observed: `DispatchModal` receives props
`{routeId, open, onClose}` only, no ETA/window evaluation, and dispatches with no warning; expected:
a known-late run is flagged, or dispatch requires acknowledging the violation, before it ships.

**Suspected cause (claim, quoted).** "grep for calculateETAs across apps/ returns exactly two
callers, both behind the /analyze endpoint (route-analysis.service.ts:92 and :270)."

### B177 — The ORS optimizer is given no start time or vehicle window, so its "hard constraint" is untethered

**Source (verbatim).** "The ORS call takes no start time and the vehicle definition carries no time
window, so the solver evaluates seconds-from-midnight job windows against an implicit zero clock
rather than the run's real departure." — "Job windows are absolute time-of-day while the vehicle's
clock is unbounded, so a 'feasible' order is never checked against the time the driver actually
leaves."

**Repro.** Input: no Google key configured (or no depot resolves) so the ORS branch runs, stops
carry delivery windows, route's real dispatch start time is e.g. 08:00 → observed: `vehicleDef` sent
to ORS has no `time_window` field at all (only `start`/`end` coordinates), so ORS's internal clock
for the vehicle defaults to an unconstrained/zero-based window rather than 08:00, making its
"hard constraint" check against the wrong clock; expected: the vehicle's time window is anchored to
the route's actual start time so ORS's feasibility check means something.

**Suspected cause (claim, quoted).** "the ORS call takes stops and depot only... the vehicle
definition has no time_window... job windows built as seconds from midnight... reachability: ORS
branch runs only when no Google key or no resolvable depot, and an unset ORS key makes the call
throw straight through to a nearest-neighbour fallback that reads no windows at all."

### B29 — Route settings exist but can't be edited

**Source (verbatim).** "Values live server-side and are read read-only (useRouteSettings) into
route-create/detail/dispatch/template-analysis screens as defaults; useUpdateRouteSettings
(PATCH /settings/route) is defined but called from nowhere." — "No screen exposes
averageSpeedKmh/serviceTimeMinutes/defaultStartTime for editing; tenants are stuck on whatever
value the API/DB currently holds."

**Repro.** Input: a tenant wants to change `averageSpeedKmh`/`serviceTimeMinutes`/`defaultStartTime`
→ observed: no UI control anywhere in the web app calls `useUpdateRouteSettings`; expected: a
settings form (or equivalent) lets ops PATCH `/settings/route`.

**Suspected cause (claim, quoted).** "repo-wide grep for `useUpdateRouteSettings` returns only its
own definition (plus a docs/web-inventory mention, not a call site)."

### B31 — CreateRouteModal is dead code

**Source (verbatim).** "CreateRouteModal.tsx (260 lines, full modal with its own form/map wiring)
is never imported anywhere in apps/web; routes/page.tsx imports EditRunModal from the same
_components directory but not CreateRouteModal, and the live create flow is
routes/create/page.tsx." — "Dead component shipped in the bundle with zero consumers, doing
nothing."

**Repro.** Input: n/a (dead-code claim, not a behavioral repro) → observed: `CreateRouteModal` has
zero application call sites; expected: a route-create flow has exactly one live implementation.

**Suspected cause (claim, quoted).** "Repo-wide grep for `CreateRouteModal` returns only its own
definition... apps/web/app/(dashboard)/routes/page.tsx:30 imports EditRunModal, not
CreateRouteModal."

## Code path

### B147

Entry: `POST :id/optimize` (route-optimization.controller.ts, two controllers — template and run
variants) → `RouteOptimizationService.optimizeTemplate` / `.optimizeRoute`.

- `optimizeTemplate`, `route-optimization.service.ts:342-376` (moved from cited 354-377 — the file
  grew above the cited block; content identical). Confirmed current text:
  ```
  const apiKey = this.config.get<string>("googleMaps.apiKey") || undefined;
  if (apiKey && depot) {
    const matrix = await this.solveWithCostMatrix(depot, stops, route, apiKey);
    ...
  } else {
    try { optimizedIds = await this.callOrsOptimization(stops, depot); } catch (...) { ... }
  }
  ```
  Branch condition is `apiKey && depot` — no window check anywhere in the condition or in either
  branch's happy path except the ORS branch's job payload (see below).
- `optimizeRoute`, `:508-530` (cited :516-540, off by ~8 lines, same content): identical
  `apiKey && depot`-gated branch, `start = origin ?? depot`.
- `solveWithCostMatrix`, `:642-682` (cited :636-690, off by ~6 lines): signature is
  `(start: LatLng, stops: StopWithCoords[], planning: PlanningFields & {avoidTolls, optimizeBy},
apiKey: string)` — `StopWithCoords` carries `deliveryWindowStart`/`End` fields (declared
  `:26-33`) but `solveWithCostMatrix` never reads them; it only extracts `{lat,lng}` via
  `points: LatLng[] = [start, ...stops.map((s) => ({lat: s.lat, lng: s.lng}))]` (line 658-ish) and
  hands the resulting cost matrix straight to `solveOrder` (`:590-631`), which operates purely on
  a `number[][]` distance/duration matrix with no window awareness at all.
- `callOrsOptimization`, `:1052-1103` (cited :1052-1080, matches at start; body runs longer than
  cited range but content matches): this is confirmed the ONLY place `time_windows` is built
  (`:1078`: `...(s.deliveryWindowStart && s.deliveryWindowEnd ? {time_windows: [[timeToSec(...),
timeToSec(...)]]} : {})`), and it is reached only in the `else` branch — i.e. only when
  `apiKey && depot` is false.
- Web toast identity: `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx:516-517` (cited
  515-521, off by ~1 line): `title: result.usedFallback ? "Route optimized (local fallback)" :
"Route optimized"` — the title only ever reflects `usedFallback`, never window compliance.
- Customer page copy: `apps/web/app/(dashboard)/customers/[id]/page.tsx:2819-2820` (cited
  2815-2818, off by ~4 lines — file has grown to 4296 lines): `"Set the customer's accepted
delivery hours. The route optimizer will schedule this stop within the window."` — this promise
  is what the code above does not keep on the cost-matrix branch.
- `apps/web/app/(dashboard)/routes/[id]/page.tsx:585-587` (cited 584-586, off by 1 line):
  `ORS_NOT_CONFIGURED: "Route intelligence is not configured. Set ORS_API_KEY in the API
environment to enable true optimization."` — this hint only fires on `usedFallback` (i.e. only
  reachable from the ORS/nearest-neighbour branch), so it can never appear for a tenant on the
  cost-matrix branch, even though that is the branch dropping window enforcement.

All four citations are confirmed at the claimed content; line numbers drifted by 1-8 lines each
(the citation-audit's "MOVED (multi-candidate)" flag), not wrong — no re-anchoring needed beyond
noting the small offsets above.

### B161

Entry: same two `optimize` controller routes, plus the separate `analyze` routes and the dispatch
UI.

- `calculateETAs`, `route-optimization.service.ts:193-231` (cited :193-235, matches almost
  exactly): this is the ONLY function in the file that computes `withinWindow` (`:211-215`:
  `withinWindow = arrivalSec >= windowStartSec && arrivalSec <= windowEndSec`).
- Grep confirms exactly two callers of `calculateETAs` in the whole `apps/` tree, both in
  `route-analysis.service.ts` (`:92` and `:270`) — the file the record cites but which is NOT
  listed in B161's own frontmatter `files:` (only `route-optimization.service.ts` and the
  templates page are declared). This mismatch — a citation pointing outside the declared file set
  — is almost certainly what the citation-audit tool flagged as `FILE_NOT_FOUND` for B161; the
  file itself exists and the line numbers are exact matches (`route-analysis.service.ts:92`:
  `const etas = this.optimizationService.calculateETAs(`, and `:270` is the second, symmetric call
  inside `analyzeRouteRun`). Both call sites sit behind `POST :id/analyze` /
  `POST route-runs/:id/analyze` (`route-optimization.controller.ts:46-50` and `:73-76`) — a
  separate endpoint from `POST :id/optimize` (`:35`, `:67`).
- `DispatchModal`, `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx:282-327` (cited
  281-327, off by 1 line): confirmed props are `{routeId, open, onClose}` only
  (`:282-290`); `handleDispatch` (`:308-322`) builds a `createRun.mutate` payload of
  `{routeId, scheduledDate, driverId, startTime}` — no analysis/ETA/window field anywhere. The
  modal is instantiated at `:1125-1129` with the same three props from the parent page, which
  holds `analysisResult` state (`:405`) but never threads it into `<DispatchModal>`.
- Optimize toast: same `:516-517` toast cited under B147 — confirmed it "reports only fallback
  usage and reordered count" per the record, no window field.
- Analyze button: `:973` (`analyzeRoute.isPending ? "Analyzing..." : "Analyze Route"`) confirmed
  as its own, separate, optional control — not on the optimize/dispatch path.

### B177

Entry: `callOrsOptimization`, `route-optimization.service.ts:1052-1103`.

- `vehicleDef` built at `:1058-1069`: `{id: 1, profile: "driving-car"}` plus `start`/`end`
  coordinates only (`:1064-1069` when depot present, else just `start`). No `time_window` key is
  ever set on `vehicleDef` — confirmed by reading the object literal in full; nothing after its
  initial declaration adds one.
- `jobs` built at `:1075-1081`: each job's `time_windows` is `[[timeToSec(deliveryWindowStart),
timeToSec(deliveryWindowEnd)]]` — i.e. **seconds since midnight**, absolute clock time, no
  reference to when the vehicle actually starts driving.
- Nothing in `callOrsOptimization`'s signature (`stops, depot` only, `:1052-1055`) receives a
  start time, and no caller (`optimizeTemplate:367`, `optimizeRoute:530`) passes one in either.
  ORS's own default vehicle time window (per ORS's API, an unbounded/zero-based window when
  omitted) is therefore compared against absolute job windows anchored to real clock time — the
  claim's mechanism.
- Reachability confirmed: this whole function is the `else` branch of `if (apiKey && depot)` in
  both `optimizeTemplate` (:342-376) and `optimizeRoute` (:508-530) — i.e. it only runs without a
  Google key or without a resolvable depot. If `ORS_API_KEY` is also unset
  (`apps/api/src/config/configuration.ts:143-144`: `ors: { apiKey: process.env.ORS_API_KEY ?? ""
}`), `callOrsOptimization` throws immediately (`:1057`: `if (!apiKey) throw new
Error("ORS_API_KEY not configured")`) and falls to `nearestNeighborFallback` (:374), which reads
  no window fields at all — confirming the verifier's note that this is "the secondary branch" of
  an already-narrow path.

### B29

Entry: `apps/web/lib/api/routes.ts`.

- `useRouteSettings`, `:672-677`; `useUpdateRouteSettings`, `:679-688` (cited `:~707`, re-anchored
  — file is 689 lines total, ~28 lines shorter than the cited anchor, consistent with the audit's
  `AMBIGUOUS_FILE`/`RE-ANCHORED` flag). Confirmed: `useUpdateRouteSettings` builds a
  `useMutation` that PATCHes `/settings/route` and invalidates `["route-settings"]` on success —
  fully wired, just uncalled.
- `grep -rn "useUpdateRouteSettings"` across `apps/web` returns exactly one hit: its own
  definition at `routes.ts:679`. No `.tsx` file imports or calls it.
- `grep -rln "useRouteSettings("` returns 4 read-only consumers: `deliveries/new/page.tsx`,
  `routes/create/page.tsx`, `routes/templates/[id]/page.tsx`, `routes/[id]/page.tsx` — matches the
  record's claimed consumer list.
- Server side confirmed real: `apps/api/src/system-config/settings.controller.ts:448`
  (`getRouteSettings`) and `:490` (`updateRouteSettings(@Body() dto: UpdateRouteSettingsDto)`),
  backed by `apps/api/src/system-config/dto/update-route-settings.dto.ts`. The endpoint is a fully
  working PATCH with no client ever calling it.

### B31

Entry: `CreateRouteModal.tsx`, `routes/page.tsx`.

- `grep -rn "CreateRouteModal"` across `apps/web` returns only: its own definition
  (`CreateRouteModal.tsx:35,40`) and its own test file
  (`CreateRouteModal.test.tsx:4,22,27,38`, which the original record did not mention — see Existing
  tests below). No `.tsx` outside the `_components` directory references it.
- `apps/web/app/(dashboard)/routes/page.tsx:30`: `import { EditRunModal } from
"./_components/EditRunModal";` — confirmed `EditRunModal` is imported, `CreateRouteModal` is
  not, from the same directory.
- The live create flow is a separate route: `apps/web/app/(dashboard)/routes/create/page.tsx`
  (file exists, referenced by B29's read-only-consumer list too, confirming it is the real create
  screen).

## History

- B147/B161/B177 shared file `route-optimization.service.ts`:
  `git log --oneline -5` → `f20ff947` (routes planning options — start/end, tolls, variants,
  Google Maps export, #472), `6b856d8d` (fix route optimization feedback / receipt upload / barcode
  scan / order auto-merge, #31), `8e38f001` (tappable route cards, optimize fallback), `754371fe`
  (resolve customer default address for run stops), `4f27d106` (driver location-aware maps,
  optimize-from-here).
  - `git blame -L 356,375` on the `apiKey && depot` branch: entirely `f20ff947f`
    (najathakram, 2026-08-28) — i.e. the cost-matrix branch and its bypass of window logic was
    introduced whole in the routes-planning-options PR, not drifted in gradually.
  - `git log -L 193,235` on `calculateETAs`: introduced in `7a51553b` ("feat: depot-aware route
    optimization, ETA calculation, and AI route analysis") — the window-check function predates
    the cost-matrix branch; the cost-matrix branch (added later, in `f20ff947`) never called it.
- `templates/[id]/page.tsx`: `git log --oneline -5` → `26ec7183` (ad-hoc order trips /
  fulfillment mode / driver-payments opt-in, #435), `a9671398` (UX/UI audit fixes), `72069288`
  (lint/typecheck/test fixes), `7a51553b` (the depot/ETA/analysis feature that created the Analyze
  tab), `dfda6038` (fix route optimization UI update, add optimize to create route).
- `routes/[id]/page.tsx`: last touched by `86844f88` (driver at-door money truth and run
  settlement, F05), `9f00684d` (proof-of-delivery artifacts), `f20ff947` (planning options — the
  same PR that added the cost-matrix branch).
- `routes.ts` (B29): `git log --oneline -5` → `60d10e66` (wave E shared enums/schema split, #621),
  `d0769701` (release orders stranded by run cancel/skip, F11), `86844f88` (F05), `28cb0a25`
  (dispatch feature toggles), `9f00684d` — none of these recent commits touch
  `useUpdateRouteSettings`; it has sat uncalled through multiple unrelated route-file changes.
- `CreateRouteModal.tsx` (B31): `git log --oneline -5` → `a9671398` (2026, UX/UI audit fixes +
  lockfile resync) is its most recent touch; before that `da97b44d`, `a03dcaea`, `92b8ff6b`,
  `e9b67b1f` ("feat(web): route management screens" — its origin). No commit since the original
  route-management-screens PR has wired it into the app; it has been dead since at least the
  `a9671398` audit-fixes commit and likely since creation.

## Existing tests around this behavior

- `apps/api/src/route-optimization/route-optimization.service.spec.ts`: covers `solveOrder`
  (2-opt correctness, fixed-end handling, distance-vs-duration divergence, 0/1-length passthrough),
  `dedupeVariants`, `applyTollContrast`, `getRouteVariants` (Google fallback, computeRoutes field
  selection, >10-intermediate Pro-tier guard, no-stops/no-depot edge cases), and
  `applyRouteVariant` (permutation validation, persistence, IN_PROGRESS 409, named-run
  re-numbering). Every stop fixture in this file sets `deliveryWindowStart: null,
deliveryWindowEnd: null` — **no test in this file ever exercises a stop with a real delivery
  window**, so nothing here pins or guards the cost-matrix branch's window blindness (B147),
  `callOrsOptimization`'s `time_windows` payload (B177), or `optimizeTemplate`/`optimizeRoute`'s
  branch selection with windowed stops.
- `apps/api/src/route-optimization/route-analysis.service.spec.ts`: covers `calculateETAs`'s
  caller only from the AI-usage-metering angle (records an `AiUsageEvent` per call, success/error/
  unparseable-response/no-key cases) — `calculateETAs` itself is `jest.fn().mockReturnValue(etas)`
  (mocked, not exercised), and no assertion in this file checks that `/optimize` or dispatch
  receives or acts on `withinWindow` (B161's gap is untested by construction — the spec only
  covers the `/analyze` side that already exists).
- No web test exercises `DispatchModal`'s props/payload for analysis data, `useUpdateRouteSettings`
  wiring, or the `routes/[id]/page.tsx` `ORS_NOT_CONFIGURED` hint (grep for these in
  `*.test.tsx`/`*.spec.ts` under `apps/web` returned nothing beyond the unrelated
  `CreateRouteModal.test.tsx`, checked next).
- `apps/web/app/(dashboard)/routes/_components/CreateRouteModal.test.tsx` exists and imports/
  renders `CreateRouteModal` directly (`isOpen`, `onClose` props) — this is a genuine, passing test
  of a component with zero application call sites. It pins the dead component's own behavior but
  says nothing about whether the app ever renders it; it does not contradict B31's dead-code claim,
  since dead-but-unit-tested is exactly the state the record describes (a full implementation
  behind a wall nothing calls).

## Production evidence

None found or supplied for this batch — no ids/amounts in the registry records, ledger shard, or
brief. Unverified whether any production tenant has hit the window-ignored path in practice (would
require a live tenant with `GOOGLE_MAPS_API_KEY` set, a resolvable depot, and windowed stops —
out of scope for this read-only pass per the test-tenant policy).

## Open unknowns

- **B147/B161/B177 fix-radius overlap**: all three touch `route-optimization.service.ts`'s
  optimize path; a real fix for B147 (making the windowed case route through ORS or add window
  awareness to `solveWithCostMatrix`) would likely also need B177's fix (anchor the ORS vehicle
  clock to the real start time) to be correct, and could naturally produce the window signal B161
  wants surfaced. S2 should check whether these three are one PR or three, and in what order —
  fixing B147 alone (routing windowed stops to ORS) without B177 would just move the "checked
  against the wrong clock" bug from unreachable to reachable.
- **B161's citation gap**: confirm with the registry maintainer whether `route-analysis.service.ts`
  should be added to B161's `files:` frontmatter (its two `calculateETAs` call sites are core to
  the claim but currently outside the declared file set) — this brief found the citation accurate,
  just mis-filed.
- **Depot-not-resolved / no-Google-key population**: unverified how common each branch is in
  production traffic (i.e. what fraction of optimize calls actually hit the cost-matrix branch vs.
  ORS/nearest-neighbour) — matters for severity calibration but requires prod telemetry, out of
  scope here.
- **Feature-shaped flags**:
  - **B29 is feature-shaped, not a defect** — the record's own frontmatter file list (`files:
apps/web/lib/api/routes.ts`) and evidence describe a fully-functioning backend capability with
    no UI ever built to expose it. Nothing here regressed; a settings-editing screen never
    shipped. This is a missing-feature / build-it-or-remove-it call (the record's own "Suggested
    fix" says as much: "add a form... otherwise remove the unused mutation"), not a wrong-value
    bug — flag for the fix-decision stage (S2/Fable) to route as a scoped feature addition (or a
    deletion) rather than a "root cause" repair.
  - **B31 is feature-shaped in the inverse direction** — it is pure dead-code removal, not a
    behavioral defect; there is no wrong output to reproduce, only an unreferenced file. Confirmed
    safe to treat as a deletion candidate, but note the existing `CreateRouteModal.test.tsx` would
    need deleting alongside it (or repurposing, if any future create-flow work wants the modal).
  - B147, B161, B177 are genuine defects with observable wrong behavior (a documented promise —
    "will schedule this stop within the window" / an implied dispatch-safety guarantee — that the
    code does not keep), not feature requests.
