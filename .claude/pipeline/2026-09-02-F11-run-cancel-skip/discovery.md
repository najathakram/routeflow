# F11 · Run cancel and skip reconciliation — discovery

> Produced 2026-09-02 by a 21-agent analysis pass (investigate -> 3 adversarial lenses per bug -> analysis -> synthesis).
> Per-bug detail lives in `.claude/campaign/bugs/B###.md`. This file is the CROSS-BUG plan.

## Verdict

**Batch coherent: NO**

F11 is coherent for THREE of its four bugs and should shed the fourth. B129 (cancel strands orders), B34 (skip never writes), B146 (skip never cascades or surfaces) are not merely related — they are one defect in three surfaces of a single state machine. I verified they collide in one method (updateStopStatus:1716-1762), one new DTO file, one reader (getOrderTracking) and one buyer card. Splitting them across parallel agents is how this batch produces a wrong-state button or a silently broken reopen.

B32 does NOT belong. "Two identical Open in Google Maps buttons" (verified at apps/mobile/app/(operator)/route-runs/[id].tsx:351 and :379, both labelled identically, one calling handleOpenInMaps and the other openRouteInMaps(stops as any)) touches zero API files, zero order state and zero cascade. Its only intersection with F11 is physical co-tenancy in one file with B129's cancel button (:385+) — a merge hazard, not a shared cause. Its defect class (duplicate-control-divergent-payload) and its proposed signature (duplicate-action-label) belong with the dead/duplicate-control family already batched as F20 (B04/B23/B94/B95/B142) and F29 (B05/B06/B07/B22/B36/B38/B39), or in a mobile route-maps batch with the driver-screen siblings its own analysis identified. RECOMMEND: move B32 to F20/F29 or a mobile-maps batch; keep F11 = B129 + B146 + B34 as a two-PR batch.

SEPARATELY, a strand this batch does NOT cover and which is reachable on the HAPPY PATH with no cancel involved: updateRunStatus's COMPLETED gate accepts SKIPPED stops (verified routes.service.ts:1424 — incomplete = stops.filter(s => s.status !== "COMPLETED" && s.status !== "SKIPPED")), so skip a stop, complete the run, and its orders are stranded exactly as in B129. That is either a new register row (B211 is next free) or an explicit scope extension of B129 — it must not stay implicit, because B34/B146 make driver-initiated skips reachable for the first time and therefore make this strand MORE frequent, not less.

## Adversarial outcome

| Bug | Severity | Still present | Refuted | What the refuter killed |
| --- | --- | --- | --- | --- |
| B32 | medium | yes | 1/3 | The root cause stands — two overlapping "Open in Google Maps" Pressables at apps/mobile/app/(operator)/route-runs/[id].tsx:350-355 (gated !isTerminal, |
| B34 | high | yes | 1/3 | The root cause is right and CORRECTIONS 1, 2 and 4 check out, but the fix as described is incomplete — it would ship a skip that is visible and un-act |
| B129 | critical | yes | 1/3 | The root-cause analysis is sound and its citations verify; the prescribed FIX is not. Unpinning orders (`routeRunId`/`routeRunStopId` → null for `stat |
| B146 | high | yes | 1/3 | The bug is real, but the claim's scope and one factual pillar are wrong, in ways that change the fix. |

Every bug was confirmed present at HEAD on the still-true and reproduces lenses. In all four the ONLY refutation came from the **fix-correctness** lens: the diagnoses in the register are sound, its *suggested fixes* are not.

## Ordering

`B129 -> B146 -> B34 -> B32`

Two PRs, not four. PR1 = B129 alone. PR2 = B146 + B34 together. B32 leaves the batch; if it stays, it lands last and alone.

B129 FIRST because it establishes the POLICY the other two must obey. Its adversarial pass already refuted the obvious fix (null the link on cancel) and settled on "never clear the pin, gate the readers instead". That decision is a precondition for B146/B34: I verified reopenStop loads stops with their orders (routes.service.ts:2683-2688) and iterates stop.orders at :2773 to reset deliveredQty and demote order status — with a comment explicitly warning that leaving deliveredQty standing bills an UNDONE delivery. I also verified settleRun's expected figure derives from run linkage at settlement time (getRunCashCollections :1484-1496, called :1684). If B34 lands first carrying its step 4 (unpin the skipped stop's orders), that invariant is violated before B129 can assert it, and reopening a skipped stop silently reverses nothing. B129 must go first so "links are never nulled; readers gate on run/stop status" is on master as tested law.

B129 also lands the first half of the shared getOrderTracking gate. B146 then EXTENDS that gate with stopStatus rather than two agents writing conflicting gates into one function — which is exactly what the two plans do today.

B146 + B34 AS ONE PR, with B146's design leading and B34's mobile caller following. They rewrite the same method, create the same DTO file, and edit the same spec. B34's own analysis says shipping it alone "converts a dead button into a wrong-state button"; B146's says "the two must ship together". Both are right. Within that PR: DTO -> updateStopStatus cascade (B146 write side) -> getOrderTracking + card copy (B146 read side) -> mobile skip caller (B34) -> delete scan-ignore.json:74. B34's mobile control is the LAST thing wired, so the button only goes live once the path behind it is correct.

B32 LAST and ideally elsewhere. Mobile-UI-only, shares no API file; its sole conflict is the operator screen it co-inhabits with B129's cancel button. Sequencing it after B129 means it rebases onto those edits instead of racing them.

## File conflicts — never parallelise these

| File | Bugs |
| --- | --- |
| `apps/api/src/routes/routes.service.ts (3 bugs; B34+B146 hit the SAME METHOD updateStopStatus:1716-1762, B129 hits createRun's sweep :936-967)` | B34, B129, B146 |
| `apps/api/src/routes/dto/update-stop-status.dto.ts — NEW FILE, both bugs CREATE it with different field sets; two agents means one clobbers the other` | B34, B146 |
| `apps/api/src/routes/routes.controller.ts — both edit the same inline @Body at :255` | B34, B146 |
| `apps/api/src/orders/orders.service.ts::getOrderTracking (:5301-5361) — same FUNCTION, and the two fixes contradict as filed` | B129, B146 |
| `apps/api/src/routes/routes.service.stop-state-guards.spec.ts — already hosts REG-B54/B55/B71/B72/B120/B121; gains REG-B34 and REG-B146` | B34, B146 |
| `apps/mobile/app/(customer)/orders/[id].tsx — same render block :251-278` | B129, B146 |
| `apps/mobile/lib/api/buyer.ts` | B129, B146 |
| `apps/mobile/lib/api/orders.ts — both flag the dead OrderTracking/useOrderTracking at :608-627` | B129, B146 |
| `apps/mobile/app/(operator)/route-runs/[id].tsx — B32 edits :351/:379, B129's cancel button is :385+` | B32, B129 |
| `.claude/campaign/status/F11.jsonl` | B34, B129, B146 |
| `.claude/code-map/api.md` | B34, B129 |
| `.claude/code-map/mobile.md` | B32, B34 |
| `.claude/code-map/_meta.json` | B32, B34, B129 |
| `.claude/lessons/LESSONS.md and .claude/lessons/_meta.json — AT the 25,600-byte cap, see risks` | B32, B34, B129 |

## Shared fixes

### B34 + B146

ONE new file apps/api/src/routes/dto/update-stop-status.dto.ts closes both bugs' validation half. Verified the endpoint at routes.controller.ts:255 takes an inline `@Body() body: { status: "IN_PROGRESS" | "SKIPPED"; driverNote?: string }` — a TSTypeLiteral, so NestJS's global ValidationPipe sees metatype Object and skips validation entirely. The DTO carries status (@IsIn(["IN_PROGRESS","SKIPPED"]) — a value SUBSET, never @IsEnum(RouteRunStopStatus), which would admit COMPLETED/PENDING), driverNote and skipReason. Both bugs need this exact file.

### B34 + B146

ONE rewrite of updateStopStatus (routes.service.ts:1716-1762). Today it is a single non-transactional routeRunStop.update with no cascade and no emit (verified). The rewrite wraps it in tenantTransaction and does all of: persist skipReason (B34), null skipReason on re-attempt (B34), reconcile the linked order both directions (B146), fire FAILED_DELIVERY (B146). One method, one transaction, one PR — splitting it produces two conflicting versions of a money-adjacent transactional method.

### B129 + B146

ONE gate in getOrderTracking (orders.service.ts:5301-5361). Verified it early-returns only on `if (!order.routeRunStop)` at :5330 — no run-status gate, no stop-status gate. B129 needs the run-status branch (CANCELLED -> no driver name, no arrival window); B146 needs the stop-status branch (SKIPPED -> explain). One edit to one function, and they MUST be designed together because as filed they contradict. B129's own case 8 already admits the overlap: "shares the fix with the B146 sibling; keeps the two from regressing apart".

### B129 + B146

ONE edit to the buyer card render block, apps/mobile/app/(customer)/orders/[id].tsx:251-278. Verified it gates on `tracking?.tracking` (not order.status), renders driverName unconditionally, and renders the "You're next on the route" / "N stops ahead" line whenever runStatus === "IN_PROGRESS" with NO stopStatus check. That single block is B129's cancel symptom AND B146's skip symptom. The `order.status === "CONFIRMED"` fallback at :276 is indeed unreachable while tracking is non-null.

### B129 + B146

ONE deletion: the dead second tracking client at apps/mobile/lib/api/orders.ts:608-627 (OrderTracking type + useOrderTracking hook, zero callers repo-wide). Both bugs flag it and both change the tracking payload shape, so leaving it creates a third mirror to drift. Delete it in whichever PR touches the shape first (B129's).

### B34 + B146

ONE decision covering BOTH un-skip paths. Two ways to leave SKIPPED exist and they currently disagree: updateStopStatus(SKIPPED -> IN_PROGRESS), a tested allowance (stop-state-guards.spec.ts:365-373) that B146 makes re-promote the order and clear skipReason; and reopenStop, which I verified accepts SKIPPED (:2697) and already demotes DELIVERED/OUT_FOR_DELIVERY -> CONFIRMED (:2774) but does not reset skipReason. B34 patches reopenStop, B146 patches updateStopStatus. Define the skip-exit contract once and apply it to both, or the same logical action reached two ways leaves different order and stop state.

## Structural opportunities (feed issue #502)

1. no-inline-body-type ESLint rule (packages/eslint-config) — highest leverage in this batch and not covered by any of the 26 existing signatures (I checked impossible-enum:328 and validation-asymmetry:922; neither matches). Fail any @Body()/@Query()/@Param() parameter in a *.controller.ts whose type annotation is a TSTypeLiteral or bare string-literal union rather than a class reference. NestJS's global ValidationPipe silently no-ops when the metatype is plain Object, so every such site is unvalidated BY CONSTRUCTION. I counted 42 live sites (customers 8, buyer-admin 3, credit-notes 3, invoices 2, buyer-admin-merge 2, plus auth/bookkeeping/notifications/routes and others). A type cannot express this — the inline type IS the type — so it must be a lint rule. Land as warn-with-baseline and burn down; B34/B146 remove the first entry.

2. provisioned-column-no-writer scan signature — verified exact: grepping skipReason across apps/api/src, apps/web, apps/mobile and schema.prisma returns EXACTLY ONE line, the schema declaration at prisma/schema.prisma:1247. Zero writers, zero readers, through the entire campaign. Parse schema.prisma for fields whose trailing comment matches /F\d\d.*(wires|nothing writes)/ and fail when no writer for that field name exists under apps/api/src. Self-retiring — goes green when the owning batch lands. Currently flags the real open set (:929 F25, :1247 B34, :2380/:2387 F27, :2803-2804 F13, :3326 F14) and stays silent on the discharged ones (:1211 F05, :1253 F10).

3. pin-released-only-by-delete scan signature — the B129 class and the most generalizable rule here. For every relation FK written non-null outside `create`, collect its release sites (F: null in a data object), resolve the enclosing method name, and flag when 100% of releases sit in methods matching /^(delete|remove|purge|destroy)/i. That is precisely B129: routeRunStopId is pinned by createRun (verified routes.service.ts:966) and released only by deleteRoute and deleteRun. States a real invariant — any link a non-destructive path can create needs a non-destructive release path or a documented status-gated reader — and generalizes to every claim/occupancy FK in the schema.

4. terminal-status-no-cascade scan signature — flag service methods named /^(update\w*Status|approve|reject|cancel|close|skip|void)/ whose body has exactly one .update() whose data object's only non-timestamp key is status, with no second write and no notify/emit call. I verified updateStopStatus is exactly this shape today. Would also have caught returns.service.ts approve/reject/markInTransit and inventory.service.ts closePurchaseOrder, both named as siblings.

5. dead-payload-field scan signature — the read-side twin, and the one that would have caught B146 the moment stopStatus was written. getOrderTracking returns stopStatus (verified :5352) and nothing in apps/mobile reads it, which is exactly why the skipped-stop case was never rendered. Flag object-literal keys returned from apps/api service methods with producer=1 and zero readers across web+mobile, EXCLUDING occurrences inside interface/type declaration bodies (a type field is not a reader). Extend the same pass to emit*(tenantId definitions in apps/api/src/gateways to catch emitStopCompleted and emitLowStock, the two emitters with no callers.

6. UN-SUPPRESS the signature that already exists and already caught B34. confirm-navigate is live at .claude/skills/bug-hunt/scripts/scan-signatures.mjs:275, and scan-ignore.json:74 suppresses it for exactly one path — apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx::confirm( — which is B34's file. The scanner was not blind, it was silenced. Deleting that single line is the structural half of the B34 fix; without it the scanner stays blind to a regression at the one site the signature was written for. Cheapest structural win in the batch.

7. duplicate-action-label scan signature (B32's class — the reason B32 can leave F11 without losing its structural value): within one .tsx, flag any multi-word user-facing label literal appearing at 2+ sites that are each descendants of an element carrying onPress=/onClick=. Requiring BOTH occurrences under a press handler excludes the trigger+modal-title pairs that dominate the false-positive set. Pair it with maps-launch-divergence (>1 call site of the same side-effecting launcher primitive in one screen file), which catches the payload split even when labels differ — the driver-screen sibling B32 identified.

## Risks

1. B34's fix step 4 IS A REGRESSION AND MUST NOT BE IMPLEMENTED. It proposes clearing Order.routeRunStopId/routeRunId when a stop is skipped. I verified reopenStop loads stops with their orders (routes.service.ts:2683-2688) and iterates stop.orders (:2773) to reset deliveredQty and demote status — with a comment explicitly warning that leaving deliveredQty standing bills an UNDONE delivery. Unpinning on skip empties that relation, so reopening a skipped stop reverses nothing. It also breaks B146's re-promotion (which needs the link to find the order) and violates the exact invariant B129's adversarial pass established for the identical unpin on cancel. Three independent reasons: B34 step 4 is refuted by its own batch-mates.

2. B129 AND B146 CONTRADICT EACH OTHER ON getOrderTracking AS FILED. B129 part 4 / case 8 wants {status, tracking: null} when the run is CANCELLED *or COMPLETED with a SKIPPED stop*. B146 part 2 requires stopStatus (and skipReason) to REACH the card so it can render "Your stop was skipped today". If B129's case 8 lands as written, B146's skip copy is unreachable and the buyer's card simply vanishes — a different flavour of the same silence. Resolve BEFORE either lands: run CANCELLED -> tracking null (B129); stop SKIPPED -> payload retained with a discriminated state the card branches on (B146). Whoever writes REG-B129 case 8 must scope it to the cancel case only.

3. B146'S WRITE-SIDE DEMOTION IS CLOSE TO A NO-OP, AND A TEST ASSERTING IT WILL PASS WHILE THE USER-VISIBLE BUG SURVIVES. I grepped every OUT_FOR_DELIVERY write in apps/api: there is NO automatic writer in the dispatch/run flow — routes.service.ts mentions it only inside reopenStop's demotion check (:2774). The only real writer is orders.service.ts changeStatus (:2455-2457), a manual operator action. So a run-attached order normally sits at CONFIRMED, the OUT_FOR_DELIVERY -> CONFIRMED demotion never fires, and the buyer's 20s poll is already false for it (buyer.ts:613-617 returns 20_000 only for OUT_FOR_DELIVERY/PARTIALLY_DELIVERED). Meanwhile the card renders off tracking?.tracking (orders/[id].tsx:251), NOT order.status, and "You're next on the route" renders on runStatus === IN_PROGRESS with no stopStatus check. THE READ SIDE IS LOAD-BEARING. Weight the test plan accordingly and make at least one REG-B146 case assert the rendered copy decision for a stop whose order status never changed.

4. TWO UN-SKIP PATHS WILL DRIFT APART. updateStopStatus(SKIPPED -> IN_PROGRESS) is an explicitly tested allowance (stop-state-guards.spec.ts:365-373) that B146 makes re-promote the order and clear skipReason. reopenStop also exits SKIPPED (verified it throws only when status is neither COMPLETED nor SKIPPED, :2697), sets the stop to PENDING and demotes the order to CONFIRMED — but B34 only adds skipReason: null there. After this batch the same logical action reached two ways leaves different order statuses (OUT_FOR_DELIVERY vs CONFIRMED). Define the contract once and apply it to both call sites.

5. B129'S SWEEP WIDENING RUNS OUTSIDE THE LOCK AND CAN DOUBLE-CLAIM. The order sweep is explicitly "outside the lock transaction" (routes.service.ts:936 comment, verified) and fans out with Promise.all of per-stop updateMany calls keyed on routeRunStopId: null. Widening that predicate to admit orders pinned to CANCELLED runs removes the property that made the null check self-serialising — two concurrent createRun calls could now both match the same released order. attachedOrderCount is derived from updateMany counts, so a double-claim would be silent. Either use a conditional update that re-asserts the old pin, or state explicitly that last-writer-wins is tolerable.

6. THE MONEY RISK IS REAL AND IS B129'S GUARD 3. The re-sweep overwrites routeRunId (verified data: { routeRunId: run.id, routeRunStopId: s.id } at :966), and settleRun's expected figure is computed from run linkage at settlement time via getRunCashCollections (:1484-1496, called from :1684), with settleRun deliberately accepting CANCELLED runs. Re-sweeping an order that already carries a CONFIRMED CASH/CHECK payment against the cancelled run retroactively SHRINKS that run's expected cash and silently changes the variance. Guard 3 (hold such orders until the cancelled run carries a settlementNote) is not optional polish — it is the difference between a correctness fix and a cash-reconciliation bug. Any REG-B129 test must assert the expected figure is unchanged across the cancel.

7. SHARED SPEC FILE AND REG TOKEN HYGIENE. routes.service.stop-state-guards.spec.ts already hosts REG-B54/B55/B71/B72/B120/B121 and gains REG-B34 and REG-B146 — the most-edited test file here, touched by both halves of PR2. Because campaign-check.mjs matches the EXACT token, note this file already contains REG-B120 and REG-B121, so a future REG-B12 in it would be unsatisfiable by collision. Keep the two new tokens in clearly separated describe blocks so PR2's halves do not conflict inside one file.

8. THE LESSONS REGISTER IS A HARD BLOCK ON CLOSING THIS BATCH. Per project memory the register sits at 27 entries / 25,529 bytes against a 25,600-byte cap — 71 bytes of headroom — and #593 landed a verify-step-2 gate reporting "binding: size (~0 more entries)". Three of these four bugs list LESSONS.md in their file sets. The FIRST close-out lesson turns npm run verify red repo-wide, and the ruling PR (#594) is explicitly the OWNER's to merge, not a session's. Sequence F11's close-out behind that ruling or plan to bump only _meta.json.updatedAt — do not let an agent discover this at merge time. Related: #583 carries a 26,533-byte register and predates the gate; merging it before #594 puts master over cap.

9. SCOPE HOLE THIS BATCH MAKES WORSE. updateRunStatus's COMPLETED gate accepts SKIPPED stops (verified routes.service.ts:1424), so skipping a stop and completing the run strands its orders on a finished run with the same permanent PREVIOUSLY_DISPATCHED outcome as B129 — on the happy path, no cancel involved. B129 as filed covers only CANCELLED (its fix explicitly leaves COMPLETED to reopenStop). Since B34/B146 make driver-initiated skips reachable for the first time, this batch increases the frequency of an uncovered strand. File it (B211) or extend B129's scope explicitly.

10. CROSS-BATCH COLLISION. B34's sibling list names apps/api/src/credit-notes/credit-notes.controller.ts as an untyped-@Body site, and that file is F09's lane, currently in flight (routeflow-30, rf-F09). If the no-inline-body-type sweep goes beyond the routes controller in this batch it will collide with F09. Restrict PR2's @Body sweep to apps/api/src/routes/routes.controller.ts (:255 plus :113/:266/:276 in the same file) and leave the other 38 sites to the lint-rule burn-down.
