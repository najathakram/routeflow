# F22 · Regulated compliance gate (ships combined as F22+F24, see below)

**Bug IDs (3):** B149, B171, B186

**Root cause:** The age/ID gate has NO WRITER for its flags — no DTO field, no service write, no settings UI — so the compliance check the product advertises can never be armed (B149). Arming it without B186 (stop flags never recomputed after dispatch) produces an uncompletable stop, and B171 (office "mark delivered" bypasses the gate entirely) leaves a hole beside it.

**Ships as:** COMBINED with F24 into ONE PR, "post-dispatch order integrity" — B134, B135, B149, B162, B163, B164, B171, B186 (8 IDs). Both wait on F07, both rewrite orders.service.ts post-dispatch paths, and B171's regulated gate is the same subject as B149's. THE REGISTER STATES B149+B171+B186 MUST SHIP IN ONE CHANGE — do not split those three even within the combined PR.

**Files:** tracked-categories DTOs + service · web regulated settings tab · routes.service.ts flag recompute · orders.service.ts changeStatus

**Together because:** B149+B171+B186 is semantic and indivisible (arming the gate without the recompute produces an uncompletable stop). Combining with F24 removes a dependency edge (both wait on F07 and both rewrite orders.service.ts post-dispatch paths).

**Guardrails / shared infra:** None new. Consumes G7's extracted lineItems const.

**Dependencies / lane notes:** Requires F07, F10 (semantic). See F24 card for the combined PR's other four IDs.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F22.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B149 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |
| B171 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |
| B186 | T1   | 0b2c3a0a       | MOVED (corrected)   |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B149 — The regulated age/ID gate has no writer for its flags, so it can never fire for any tenant

**Area:** Regulated POD · API + web + mobile

**Meant to do:** A tenant marks a category (alcohol, tobacco) as age- or ID-restricted; deliveries carrying it then demand a signature plus age/ID confirmation and refuse a safe drop — as the shipped user guide describes.

**Actually does:** TrackedCategory.requiresAgeCheck / requiresIdCheck default false and nothing can set them true: no DTO field, no service write, no settings UI, no backfill script — and forbidNonWhitelisted rejects a hand-crafted call.

**The gap:** The whole gate short-circuits when no category is flagged, so the compliance check the product advertises can never be armed.

**Evidence:** Repo-wide grep for requiresAgeCheck returns exactly 7 files: schema.prisma:3548-3549 (@default(false)), migrations/0_init/migration.sql:1925-1926, common/regulated-delivery.ts, its spec, demo-seed.js and two code-map docs. Reader side: apps/api/src/common/regulated-delivery.ts:84-96 (the only reader), :117 (early return when nothing is flagged), :158-195 (every throw wrapped in the requires-guard). No writer: create-tracked-category.dto.ts and update-tracked-category.dto.ts declare neither field, tracked-categories.service.ts:166-182 spreads the DTO only, and main.ts:180-186 rejects the extra property. Downstream goes quiet at apps/api/src/routes/routes.service.ts:1008-1027 and apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx:279-300 plus lib/pod-gating.ts:34. The guide promise is at local-assets/docs/routeflow-user-guide.html:3977 and :3999.

**Suggested fix:** Add requiresAgeCheck / requiresIdCheck to the create and update TrackedCategory DTOs and expose them as toggles in the Regulated settings tab so a tenant can actually arm the gate.

### B171 — Office "mark delivered" bypasses the regulated POD gate entirely

**Area:** Regulated delivery · API (orders changeStatus)

**Meant to do:** A regulated order only reaches DELIVERED after the age/ID/signature capture the POD gate demands, so every delivered regulated order carries a compliance record.

**Actually does:** changeStatus writes DELIVERED, stamps deliveredAt and fires the invoice after only role, transition-matrix, demotion-reason and draft-licence checks. No regulated helper is called, and the linked stop stays PENDING with its verification flags false.

**The gap:** The POD gate lives only on the two stop-completion methods; the order-status path that reaches the same terminal state has no equivalent guard.

**Evidence:** apps/api/src/orders/orders.service.ts:2142-2164 (role gate), :2172-2182 (the matrix allows CONFIRMED→DELIVERED and OUT_FOR_DELIVERY→DELIVERED), :2199-2213 (the method does look up the route-run stop, but only for the reverse demotion), :2245-2264 (the write), :2272-2290 (auto-invoice), :50-55 (imports assertRegulatedDeliverySatisfied and three siblings — an in-file grep returns only those four lines, so all four imports are dead since #273 removed the last use); the surviving gate is at apps/api/src/routes/routes.service.ts:1681-1698 and :1869-1894, and routes.service.ts:1900 even comments on "one the office already marked DELIVERED".

**Suggested fix:** In changeStatus, when the target status is DELIVERED and the order carries a regulated line (or is linked to an incomplete route-run stop), either refuse and redirect staff to the stop-completion flow or run the derive-and-assert pair on the supplied capture — the imports are already there.

### B186 — Stop regulated flags are never recomputed after dispatch, so the driver UI cannot satisfy the server gate

**Area:** Regulated POD · API + mobile

**Meant to do:** When a stop turns out to carry regulated goods, the driver sees the age/ID checkboxes and the ID-type picker, ticks them, and completes the stop.

**Actually does:** Stop flags are written once at run creation and only ever to true. Completion re-derives the requirement authoritatively from current orders, so an order linked after dispatch makes the gate throw while the driver UI, reading the stale flags, renders no controls at all.

**The gap:** The server derives requirements live; the driver UI derives them from a dispatch-time snapshot that is never refreshed, leaving a stop the app cannot make completable.

**Evidence:** apps/api/src/routes/routes.service.ts:~787 [re-anchored master@6c8f1401; was :965-969 at hunt round master@0b2c3a0a] (the sole call site, inside createRun) and :1008-1027 (it returns early when nothing is flagged and never writes false); the authoritative re-derivation at :1682-1698 (whose own comment notes orders can be linked after dispatch) and :1866-1880; apps/api/src/common/regulated-delivery.ts:112-135 and :158-195; client side, apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx:279-300 (the whole Age & identity block is gated on the persisted stop flags) and apps/mobile/lib/pod-gating.ts:34, called from payment.tsx:224-237.

**Suggested fix:** Return a server-derived requirement on the stop payload, or recompute the stop flags — allowing false — whenever an order's stop link changes, so the driver UI renders the controls the completion gate will demand.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
