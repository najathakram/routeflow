# S2 cause refutation — F12 (B147, B161, B177, B29, B31)

Tree read: main checkout `C:/ClaudeCode/routeflow`, `git rev-parse HEAD` = **12cdc26a**
(working tree clean except `.claude/settings.local.json`). Read-only pass; no worktrees touched.
Every line number below is from this sha. Method: for each record I assumed the suspected cause is
**wrong** and looked for the thing that would make it wrong — a second enforcement site, a caller
that does pass the missing input, a UI that does call the "uncalled" hook, a consumer of the "dead"
file. Where the refutation failed, the verdict is `confirmed` and the failed refutation is recorded
so the lead can see what was actually excluded.

---

## B147 — Delivery windows silently ignored whenever a Google Maps key is configured

**Verdict: confirmed** (cause exactly as claimed; **title scope is too wide** and the register's
suggested fix is **refuted** — see below).

### Refutation attempts (all failed)

1. _"Something downstream re-checks the windows before the order is written."_ — Refuted by grep:
   `withinWindow` exists in exactly two API sites, `route-optimization.service.ts:211-227`
   (`calculateETAs`) and its two consumers in `route-analysis.service.ts:119,296`. Nothing on the
   optimize path reads it. `optimizeTemplate` writes the new `stopNumber`s at
   `route-optimization.service.ts:389-406` and returns `{stopOrder, reorderedCount, usedFallback,
fallbackReason}` (`:413`, type at `:51-56`) — no window field exists on `OptimizeResult` to
   re-check.
2. _"The window fields never reach the branch, so the branch cannot be dropping them."_ — Refuted:
   they are selected (`:263-267`, `customer.deliveryWindowStart/End`), mapped onto every stop
   (`:325-326`), and typed on `StopWithCoords` (`:32-33`). The data is present and dropped.
3. _"`solveWithCostMatrix` passes windows through to the matrix builder."_ — Refuted:
   `:642-647` takes `(start, stops, planning{avoidTolls,optimizeBy,endKind,endLat,endLng}, apiKey)`;
   at `:657` it reduces the stops to `points: LatLng[] = [start, ...stops.map(s => ({lat, lng}))]`.
   `buildCostMatrices` (`cost-matrix.ts:78-85`) has no window parameter at all, and `solveOrder`
   (`:590`) takes `(cost: number[][], permutable, endIndex?)` — a pure geometry/2-opt solver.
   **Diverging line: `route-optimization.service.ts:657`** — the window fields die here.
4. _"The branch is unreachable in practice / the ORS branch is the norm."_ — Refuted the other way:
   `googleMaps.apiKey` is a plain env read (`config/configuration.ts:146`), and geocoding stops
   already demands that key (`:314-316` error text "Set GOOGLE_MAPS_API_KEY to auto-geocode"), so a
   tenant with geocoded stops is overwhelmingly on the Google branch. (Prod key state itself is
   _unverified_ — no prod access in this pass.)

### Repro traced to the wrong output

`POST /routes/:id/optimize` (`route-optimization.controller.ts:67-70`) → `optimizeTemplate`
(`:342`) → `resolveDepot` (`:127`) → **`if (apiKey && depot)` at `:356`** → `solveWithCostMatrix`
(`:361`) → `points` at `:657` (windows dropped) → `solveOrder` (`:670`, cost-only) → stop order
persisted `:389-406`. Wrong output: a stop whose window is 08:00–10:00 is placed after a
no-window stop purely because the cost matrix is cheaper that way; the client toast reads
`"Route optimized"` (`routes/templates/[id]/page.tsx:516`) with no caveat, against the promise at
`customers/[id]/page.tsx:2819-2820` ("The route optimizer will schedule this stop within the
window"). The `ORS_NOT_CONFIGURED` hint (`routes/[id]/page.tsx:585-586`) can only fire on the
_other_ branch, so it can never appear for the tenant actually losing window enforcement.

### Scope corrections the lead should carry

- The branch condition is `apiKey && depot` (`:356`) / `apiKey && start` where `start = origin ??
depot` (`:512`, `:519`) — so the title's "whenever a Google Maps key is configured" is **necessary
  but not sufficient**: a tenant with no resolvable depot and no driver origin still falls to ORS.
  Also `solveWithCostMatrix` withholds the billable call under 2 stops (`:661`), where the order is
  trivial anyway.
- **The generalized defect is bigger than the Google branch:** _no_ optimize path enforces windows
  against a real clock. ORS gets absolute job windows but no vehicle clock (B177), and
  `nearestNeighborFallback` (`:1120`) reads no window field at all. Treating B147 as "route the
  windowed case to ORS" therefore **refutes the register's suggested fix**: it moves the bug from
  unreachable to reachable rather than fixing it (cf. L-081 — put the guard in the primitive that
  performs the write, not at one call site).

### Minimal fix shape (claim for the lead to rule on)

- Files: `apps/api/src/route-optimization/route-optimization.service.ts` (only file needed for the
  invariant); optionally `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx` +
  `apps/web/app/(dashboard)/routes/[id]/page.tsx` for the disclosure half.
- Edit shape: make window feasibility part of the **ordering primitive's** contract, not of one
  branch — i.e. `solveOrder`/`solveWithCostMatrix` receive the stops' window data plus the run's
  start time and either (a) order under a window-first key with cost as tiebreak, or (b) keep the
  cost order and run a post-solve `calculateETAs` pass that repairs / reports violations. Whichever
  is chosen must sit at the single seam `optimizeTemplate` (`:356`) and `optimizeRoute` (`:519`)
  already share, so `getRouteVariants` (`:736`, `:779`) inherits it.
- Invariant to pin: **for any stop set where a window-feasible order exists, the persisted order is
  window-feasible; where none exists, the result says so** — the same invariant on the Google, ORS
  and nearest-neighbour branches (one invariant, three branches).

### REG test that fails today on the exact wrong value

- File: `apps/api/src/route-optimization/route-optimization.service.spec.ts` (new
  `describe("optimizeTemplate — delivery windows")`; harness already exists at `:10-31` —
  `createMockPrisma`, `ConfigService.get` jest mock, `SystemConfigService` mock).
- Setup: `configGet` returns `"test-key"` for `googleMaps.apiKey`; a route fixture like `mockRoute()`
  (`:215-252`) but with a **depot** and **three** stops, geography chosen so the pure-cost optimum
  is `[near, mid, far]` while `far` carries `deliveryWindowStart/End = "08:00"/"09:00"` and the
  others carry none — i.e. the window order is `[far, …]`. Mock `global.fetch` to **reject**
  (as `:255-258` already does) so `buildCostMatrices` returns the deterministic haversine matrix —
  haversine results are deliberately **not cached** (`cost-matrix.ts:30-33`), which sidesteps the
  module-level `matrixCache` (`:44`) leaking between tests; a test that instead mocks a Google
  matrix must use unique coordinates per case.
- Expected: `result.stopOrder[0].stopId === "stop-far"` (window-feasible order persisted, or the
  result carries an explicit violation signal, per the ruled fix shape).
  Received today: `stop-near` first — the cost order — with `usedFallback: true` and no window
  field anywhere on the result.

### Tests that currently pin the wrong behavior

None. `route-optimization.service.spec.ts` never calls `optimizeTemplate`/`optimizeRoute` at all
(it covers `solveOrder`, `dedupeVariants`, `applyTollContrast`, `getRouteVariants`,
`applyRouteVariant`), and **every** stop fixture sets `deliveryWindowStart: null,
deliveryWindowEnd: null` (`:234-235`, `:246-247`, `:283-284`, `:295-296`, `:409-410`). Nothing has
to be unpinned; the fix adds coverage where there is none.

### Siblings of the same defect class (grep evidence)

- `getRouteVariants` → `solveWithCostMatrix` at `:736` and `:779`; `applyRouteVariant` persists the
  chosen variant — a second writer of a window-blind order.
- `nearestNeighborFallback` (`:1120`+) — reads only `lat/lng` via `haversineKm`; windows absent.
- Ad-hoc trips share the same endpoints by design (`route-optimization.controller.ts:21` —
  "optimize/analyze are SHARED between the two delivery features"), so trips inherit the defect;
  `trips.service.ts` has no optimizer of its own (grep: only `optimizeBy` passthrough at `:308`,
  `:558`).

**Feature-shaped (D5)? No** — a documented promise vs. code behavior, observable wrong order.
**Tier T1** (jest, API service level; the toast half is cosmetic and can ride the same PR without
an E2E).

---

## B161 — The window-violation check gates nothing (Optimize and Dispatch never consult it)

**Verdict: confirmed** (and **worse than filed** on two axes — see siblings).

### Refutation attempts (all failed)

1. _"The optimize response carries the evaluation and the UI just doesn't show it."_ — Refuted:
   `OptimizeResult` (`route-optimization.service.ts:51-56`) is `{stopOrder, reorderedCount,
usedFallback, fallbackReason?}`; nothing else is returned (`:413`).
2. _"The server blocks or warns at dispatch."_ — Refuted: `routes.service.ts:808-900+` (`createRun`)
   validates ad-hoc/orderIds pairing, address resolution, driver fallback and duplicate active runs;
   a grep for `window` in that file returns only unrelated Prisma `select` clauses (`:105-106`,
   `:128-129`, `:1163-1164`, `:1186-1187`) and two comments. No feasibility check exists.
3. _"`DispatchModal` derives the analysis itself."_ — Refuted:
   `routes/templates/[id]/page.tsx:282-290` — props are exactly `{routeId, open, onClose}`; the only
   hook it adds is `useRouteSettings()` for `defaultStartTime` (`:296`, `:304-307`). The parent
   holds `analysisResult` (`:406`) and never threads it into `<DispatchModal>` (`:1125-1129`).
4. _"Window evaluation is unavailable without the AI key, so wiring it into optimize is
   impossible."_ — Refuted, and this **strengthens the fix**: `analyzeRoute` computes `etas` via
   `calculateETAs` _before_ resolving the Anthropic key and returns `{configured:false, etas}` when
   no key exists (`route-analysis.service.ts:91-105`). The window evaluation is pure, free and
   AI-independent.
5. _"`calculateETAs` has other callers that already gate something."_ — Refuted: exactly two callers
   repo-wide, `route-analysis.service.ts:92` and `:270`, both inside `/analyze`
   (`route-optimization.controller.ts:46-50`, `:73-76`) — a different endpoint from `/optimize`
   (`:35`, `:67`).

**Citation-audit note:** the audit's `FILE_NOT_FOUND` for B161 is a **mis-filing, not a bad
citation** — `route-analysis.service.ts` is absent from B161's frontmatter `files:` while its cited
lines `:92` and `:270` match the current tree exactly. Recommend adding that file to the record's
`files:` rather than re-anchoring anything.

### Repro traced to the wrong output

Operator optimizes (toast at `:516-517` reports only fallback + reordered count) → opens Dispatch
(`:1125`) → `handleDispatch` (`:308-322`) posts `{routeId, scheduledDate, driverId, startTime}` →
`createRun` (`routes.service.ts:808`) creates the run. Wrong output: a run is created from an order
whose known-late stops were never computed, with no warning at any step; the only place
`withinWindow` is rendered is the Analysis tab of the same page (`:1053`, `:1057`), reachable only
by clicking "Analyze Route" (`:959-973`) **after** the reorder has already been persisted.

### Minimal fix shape (claim for the lead to rule on)

- Files: `apps/api/src/route-optimization/route-optimization.service.ts` (extend `OptimizeResult`),
  `apps/web/app/(dashboard)/routes/templates/[id]/page.tsx` **and**
  `apps/web/app/(dashboard)/routes/page.tsx` (the second dispatch modal — see siblings).
- Edit shape: have the optimize path run the existing `calculateETAs` against the _persisted_ order
  and return the late-stop list on `OptimizeResult`; surface it in the optimize toast and pass the
  same evaluation (or re-derive it at open) into both dispatch modals as a warning that is shown or
  acknowledged. This is the same seam B147's fix touches — **one PR, not two** (the B147 fix
  produces the signal B161 needs to display).
- Invariant: **no run reaches `createRun` from a UI that has not been shown the window evaluation of
  the exact order being dispatched.** Per L-081, prefer computing it where the order is written
  (service) over each call site.

### REG test that fails today on the exact wrong value

- T1 file: `apps/api/src/route-optimization/route-optimization.service.spec.ts` — same fixture as
  B147's but with a stop whose window closes before its reachable ETA. Expected:
  `result.windowViolations` (name per the ruled shape) contains that `stopId`. Received today:
  `undefined` — the field does not exist.
- T2 file (web, per D1): the dispatch flow on `routes/templates/[id]/page.tsx` — an E2E in the
  existing `apps/web/e2e/` style asserting the dispatch modal shows a late-stop warning for a
  windowed `test`-tenant route. Assert the toast through the notifications region, never a bare
  `getByText` (**L-076**).

### Tests that currently pin the wrong behavior

None pin it. `route-analysis.service.spec.ts` mocks `calculateETAs` outright (the `etas` fixture at
`:40-49` with `withinWindow: null`, the optimization service injected as a mock) and only asserts AI
usage metering — a **result-injecting mock** that would stay green through the fix (L-081's exact
hazard). No web test renders `DispatchModal`.

### Siblings of the same defect class (grep evidence)

- **A second, duplicated `DispatchModal` at `apps/web/app/(dashboard)/routes/page.tsx:71-79`**
  (used at `:596`) — same three props, and it does not even send `startTime` (`:99`), so its runs
  have `run.startTime = null` and later analysis falls back to `route.defaultStartTime`
  (`route-analysis.service.ts:243-247`). Not cited in the record; it is inside the fix radius.
- `useAnalyzeRouteRun` (`apps/web/lib/api/routes.ts`) has **zero call sites in `apps/web/app` or
  `components`** (unused-hook sweep under B29) — the run-side window evaluation is unreachable from
  the web UI entirely, not merely optional.
- **Mobile is worse:** `apps/mobile` references `useOptimizeTemplate` (4×) and `useOptimizeRouteRun`
  (5×) but `useAnalyzeRoute`/`useAnalyzeRouteRun` **0×**, and `withinWindow` appears **0×** anywhere
  under `apps/mobile` — the primary operator surface can reorder and dispatch with no window signal
  at all.

**Feature-shaped (D5)? No** — the evaluation exists and is deliberately not consulted; that is a
wiring defect with an operational wrong outcome. **Tier T1** for the API half + **T2** for the web
dispatch half (web-side rows are T2 per D1).

---

## B177 — ORS gets no start time or vehicle window

**Verdict: confirmed** on the code fact; **one sub-claim marked unverified** (external solver
semantics), which does not change the defect.

### Refutation attempts

1. _"A caller passes the start time and the record missed it."_ — Refuted: `callOrsOptimization`'s
   signature is `(stops, depot?)` only (`:1052-1055`); its two callers pass exactly two arguments
   (`:367` `callOrsOptimization(stops, depot)`, `:530` `callOrsOptimization(stops, start)`). The
   route's `defaultStartTime` and the run's `startTime` are read only in the analysis path
   (`route-analysis.service.ts:72`, `:243-247`) — never in the optimize path.
2. _"`vehicleDef` gets a time window later in the body."_ — Refuted by reading the literal in full:
   `:1059-1062` (`id`, `profile`), then `:1064-1070` (`start`/`end` coordinates only). Nothing else
   mutates `vehicleDef` before it is sent at `:1073`.
3. _"Job windows are relative offsets, so a zero-based vehicle clock is consistent."_ — Refuted:
   `timeToSec` (`:36-39`) is `h*3600 + m*60` on an `"HH:mm"` string, i.e. **absolute
   seconds-from-midnight**, and `sales.prisma:132-133` stores `deliveryWindowStart/End` as
   `String?`. Job windows are wall-clock; the vehicle's clock is whatever the solver defaults to.
4. **Unverified sub-claim:** that the solver's default vehicle window is specifically "zero-based /
   unbounded" is an assertion about openrouteservice/VROOM semantics I cannot verify read-only.
   Immaterial: whatever the default is, it is **not** the run's real departure time, which is the
   defect. State the finding that way rather than as "an implicit zero clock".

### Repro traced to the wrong output

No Google key (or no resolvable start) → `else` branch (`:365-376` / `:528-539`) →
`callOrsOptimization` → body at `:1072-1081` carries absolute job windows and a clock-less vehicle
→ ORS returns an order (`:1097-1105`) that is "feasible" only under a departure time nobody chose,
and it is persisted unchanged (`:389-406`). With `ORS_API_KEY` unset (`configuration.ts:143-144`,
`""` default) the call throws at `:1057` and `nearestNeighborFallback` (`:1120`) produces an order
with **no** window input at all.

### Minimal fix shape (claim for the lead to rule on)

- File: `apps/api/src/route-optimization/route-optimization.service.ts` only.
- Edit shape: thread the effective start time (run `startTime` → route `defaultStartTime` →
  `"08:00"`, i.e. the precedence `route-analysis.service.ts:243-247` already implements — lift it to
  one shared helper rather than a fourth hand-rolled copy) into `callOrsOptimization` and set it as
  the vehicle's time-window lower bound; then re-validate the returned order with `calculateETAs`
  before reporting success.
- Invariant: **the clock the solver reasons on equals the clock the ETA pass reasons on** — one
  start-time resolution, used by optimize and analyze alike.
- Ordering note for the lead: **B177 must land with (or before) B147**, not after. If B147 is fixed
  by preferring ORS for windowed stop sets, B177 turns a currently-narrow modelling defect into the
  main path.

### REG test that fails today on the exact wrong value

- File: `apps/api/src/route-optimization/route-optimization.service.spec.ts`, new
  `describe("callOrsOptimization")` — drive `optimizeTemplate` with `configGet` returning `undefined`
  for `googleMaps.apiKey` and `"ors-key"` for `ors.apiKey`, and a `global.fetch` jest mock that
  resolves a valid `{routes:[{steps:[…]}]}`.
- Expected: `JSON.parse(fetch.mock.calls[0][1].body).vehicles[0].time_window` equals
  `[timeToSec(startTime), …]` for the route's configured start time. Received today: `undefined` —
  `vehicles[0]` has only `{id, profile, start, end}`. The assertion is on the **request payload**, so
  it is independent of ORS's response and of the solver's semantics.
- Keep the clock as **data** in the fixture (an explicit `"08:00"` from the mocked
  `SystemConfigService`), never a host-clock derivation (**L-047**).

### Tests that currently pin the wrong behavior

None — no spec calls `callOrsOptimization`, directly or through `optimizeTemplate`.

### Siblings

`nearestNeighborFallback` (`:1120`) is the same class one level down (no window input at all), and
it is the **default** whenever `ORS_API_KEY` is empty. Any "windows are respected" claim must name
which of the three branches ran.

**Feature-shaped (D5)? No** (defect), but it is **not independently shippable value** — it is the
correctness half of B147. **Tier T1.**

---

## B29 — Route settings exist but can't be edited

**Verdict: confirmed as a fact; classified feature-shaped (D5) → recommend defer/split from the
engine fix.**

### Refutation attempts (all failed)

1. _"Some screen PATCHes `/settings/route` directly without the hook."_ — Refuted: repo-wide grep in
   `apps/web` for `settings/route` returns exactly two lines, both in `lib/api/routes.ts`
   (`:675` GET, `:686` PATCH). No `.tsx` touches the path.
2. _"A generic system-config editor can set `route.*` keys."_ — Refuted:
   `grep -rn "system-config|systemConfig" apps/web` returns **nothing**; the
   `route.averageSpeedKmh` / `route.serviceTimeMinutes` / `route.defaultStartTime` keys are written
   only by `apps/api/src/system-config/settings.controller.ts:492-498`.
3. _"Mobile exposes the editor."_ — Refuted: `apps/mobile/lib/api/routes.ts:641` is a **GET-only**
   `useRouteSettings`; no mobile PATCH of `/settings/route` exists.
4. _"The hook is referenced somewhere non-obvious (barrel, dynamic import)."_ — Refuted by an
   unused-hook sweep over all 459 exported hooks in `apps/web/lib/api/*.ts` against every file under
   `app/` and `components/`: `useUpdateRouteSettings` is one of 34 with zero references.

Server side is real and reachable: `settings.controller.ts:447-486` (`getRouteSettings`, defaults
50 km/h / 15 min / `"08:00"`) and `:489-501` (`updateRouteSettings`, whitelisted DTO). The values
are consumed by `route-analysis.service.ts:70-72` and `:251-254`, so editing them changes real ETA
output — the capability is live, only the UI is missing.

### D5 call

**Feature-shaped: yes.** There is no wrong value and no regression — a settings screen was never
built. Recommend the lead either (a) route it as a scoped feature (a "Route planning" card in the
Settings hub bound to `useUpdateRouteSettings`) outside the F12 engine PR, or (b) rule the inverse
(delete the mutation) — but note (b) strands a working API and makes B147/B177's start-time
behaviour permanently unconfigurable, so (a) is the coherent choice **after** the engine fix.

### Minimal fix shape (if built)

- Files: a new settings section under `apps/web/app/(dashboard)/settings/…`;
  `apps/web/lib/api/routes.ts` needs no change — the hook exists.
- Edit shape: one form (avg speed, service minutes, default start time) bound to
  `useUpdateRouteSettings`; depot stays read-only (it derives from `TenantConfig`,
  `settings.controller.ts:453-476`).
- Invariant: every value `GET /settings/route` returns as a planning default is editable by an
  operator through exactly one screen.

### REG test

T2 (web, per D1): an E2E on the `test` tenant that changes `defaultStartTime`, reopens the dispatch
modal and asserts the new default is pre-filled (`templates/[id]/page.tsx:304-307` already consumes
it). Fails today at the first step — no control exists to change it. No T1 test can express this
(the API already works and is covered on its own).

### Tests pinning the wrong behavior

None.

### Siblings (grep evidence)

The unused-hook sweep found **34** exported hooks in `apps/web/lib/api/*.ts` with zero references in
`app/` or `components/`, including `useAnalyzeRouteRun` (relevant to B161), `useUpgrade` /
`useDowngrade` / `useProrationPreview` (billing), `useToggleUrgent`, `useApplyAdvanceToInvoice`,
`useDeleteVendorBill`, `useChangeDriverStatus`. B29 is one instance of a repo-wide class; a lint/CI
guard for "exported API hook with no consumer" is the durable guard, not five one-off screens.
(Recommend surfacing that to the lead rather than widening F12.)

**Tier T2.**

---

## B31 — CreateRouteModal is dead code

**Verdict: confirmed (dead code); feature-shaped (D5, inverse) — a deletion, not a defect fix.**

### Refutation attempts (all failed)

1. _"It is imported dynamically or re-exported."_ — Refuted: repo-wide grep for `CreateRouteModal`
   across `apps`, `packages`, `docs` returns only its own definition
   (`apps/web/app/(dashboard)/routes/_components/CreateRouteModal.tsx:35,40`), its own test
   (`CreateRouteModal.test.tsx:4,22,27,38`) and one audit-data JSON row
   (`docs/audit/2026-08-22-web-layout/data/static.json:1209`). No `next/dynamic`, no barrel.
2. _"`routes/page.tsx` renders it under another name."_ — Refuted: `routes/page.tsx:30` imports
   `EditRunModal` from the same `_components` directory; the live create flow is the separate route
   `apps/web/app/(dashboard)/routes/create/page.tsx`.

### D5 call and fix shape

**Feature-shaped: yes (inverse).** There is no repro and no wrong value — only an unreferenced file,
so there is **no REG test that can fail today on a wrong value**. The honest guard is static, not
behavioral.

- Files: delete `CreateRouteModal.tsx` **and** `CreateRouteModal.test.tsx` (the test is the only
  thing that breaks; it is a genuine, currently-passing test of a component nothing renders).
- Invariant: no component file under `apps/web/app/**/_components/` is referenced only by its own
  test.
- Guard instead of a REG test: a dead-file check in CI (the sweep below already implements the
  logic).

### Siblings (grep evidence)

A component-file sweep over `apps/web/app` + `apps/web/components` (files whose basename is
PascalCase, excluding `*.test.*`/`*.spec.*`) found exactly **three** with zero non-test references:
`app/(dashboard)/routes/_components/CreateRouteModal.tsx`, `components/InstallAppButton.tsx`,
`components/ReportChart.tsx`. Repo-wide grep confirms the latter two are referenced nowhere outside
their own files either. If the lead rules "delete", ruling on all three at once costs nothing extra;
if the lead rules "keep", B31 should be closed won't-fix rather than left queued.

**Tier T3.**

---

## Overall

Three of the five records survive refutation as genuine defects, and they are **one mechanism seen
from three angles, not three bugs**: `route-optimization.service.ts` selects an engine on
`apiKey && depot` (`:356`, `:519`), the selected engine drops the window fields at `:657`, the
alternate engine gets absolute job windows with no vehicle clock (`:1059-1081`), the third
(nearest-neighbour, `:1120`) ignores windows outright, and the one function that does evaluate
windows (`calculateETAs`, `:193-231`) is wired only to `/analyze`. Every citation in all three
records is accurate on the current tree; the only audit flag that mattered — B161's
`FILE_NOT_FOUND` — is a frontmatter omission (`route-analysis.service.ts` missing from `files:`),
not a wrong line. What I _do_ refute is the framing and the register's fixes: B147's title overstates
reachability (a resolvable depot or driver origin is also required), and "prefer ORS when windows
exist" is not a fix while B177 stands — it makes a broken clock the main path. So B147 + B161 + B177
should be ruled as **one PR with one invariant** (a window-feasible order, evaluated against the real
departure clock, enforced at the shared write seam per L-081, and reported on the optimize result so
both dispatch modals can show it), with three REG tests that each fail today on a different exact
value: the persisted stop order (B147), the missing violation field on `OptimizeResult` (B161), and
the missing `vehicles[0].time_window` in the ORS request body (B177). Nothing in the existing specs
pins any of the wrong behavior — every window fixture in `route-optimization.service.spec.ts` is
`null`, and `route-analysis.service.spec.ts` mocks `calculateETAs` — so the risk is the inverse of a
stuck test: a fix a result-injecting mock would never notice. The remaining two are not defects:
**B29 is a missing feature** (a working PATCH endpoint with no screen; one of 34 orphaned hooks
repo-wide) and **B31 is dead-code deletion** (one of three orphaned components), and both should be
split out of the engine PR — B29 deferred to a scoped settings-form decision, B31 ruled
delete-or-close alongside `InstallAppButton.tsx` and `ReportChart.tsx`. Two facts outside the records
belong in the fix radius: a **second `DispatchModal`** at `routes/page.tsx:71` that does not even
send `startTime`, and **mobile**, which calls optimize 9× but never calls analyze and never renders
`withinWindow` anywhere.
