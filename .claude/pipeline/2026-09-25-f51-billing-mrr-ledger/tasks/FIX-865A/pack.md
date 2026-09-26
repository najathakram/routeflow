# Review pack — build-plan.md — files: apps/api/src/billing/addon-ledger.ts — base: 4e80b024a232f70c57d04eb1d3220d8cd7b5996b

## Spec excerpt

## Objective

B863 manual activation never writes `cycle` (365-day row rolls +1mo). B864 override on a TRIAL tenant books +monthly, activation books it again. B865 admin add-on path writes no `priceSnapshot`/no emit; self-serve emits ungated; disable books −catalog. B866 `byPlan[].baseMrr` net vs top-level gross.
**Out of scope:** non-30/365 proration (own bug); whether prepaid rows roll (B327); data repair (none); B868/B869.

## Acceptance criteria

1. B863 both upsert branches write `cycle` (30→MONTHLY, 365→ANNUAL); external rows roll by prior length; Stripe rows unchanged.
2. B864 non-paying override writes the snapshot, emits nothing; activation books +1200 exactly once; both under `FOR UPDATE`.
3. B865 four sites → one helper; priced admin enable snapshots + gated emit; disables book −stored snapshot; unpriceable `stripePriceId` → 400 before Stripe; D1 in the PR.
4. B866 `Σ byPlan.baseMrr === baseMrr`; `mrr === baseMrr − discountTotal + addonMrr` (408/1346 fixtures).
5. No module/DTO/schema/`rollCycles`-`where` change; no live catalog read in any disable path.

## Diff

```diff
diff --git a/apps/api/src/billing/addon-ledger.ts b/apps/api/src/billing/addon-ledger.ts
new file mode 100644
index 00000000..568941f4
--- /dev/null
+++ b/apps/api/src/billing/addon-ledger.ts
@@ -0,0 +1,49 @@
+import { Prisma } from "@prisma/client";
+import { roundMoney } from "@routeflow/pricing";
+import { BillingEventService } from "./billing-event.service";
+import { BILLING_EVENTS, type BillingEventType } from "./plan-catalog.constants";
+import { isPayingRow } from "./mrr.service";
+
+export interface AddonDelta {
+  tenantId: string;
+  sku: string; // catalog SKU code (caller bridges a legacy addonKey)
+  priceSnapshot: unknown; // the STORED TenantAddon.priceSnapshot — never a live catalog read on disable
+  deltaQty: number; // +qty enabled / −qty disabled; 0 emits nothing
+  actorId?: string | null;
+  payload?: Prisma.InputJsonObject;
+}
+
+/**
+ * B865 / SA-277 — the single add-on ledger writer (L-167): every enable/disable site books through here INSIDE
+ * its tx — lock the tenant row (SA-163), read the paying-set inputs under it, emit ±priceSnapshot × deltaQty
+ * ONLY for a paying row. A TRIAL tenant's add-on is booked once, at activation, from the same stored snapshot.
+ * Returns the amountDelta booked (0 when gated).
+ */
+export async function emitAddonDelta(
+  tx: Prisma.TransactionClient,
+  events: BillingEventService,
+  d: AddonDelta,
+): Promise<number> {
+  if (d.deltaQty === 0 || d.priceSnapshot == null) return 0;
+  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${d.tenantId} FOR UPDATE`;
+  const row = await tx.tenant.findUniqueOrThrow({
+    where: { id: d.tenantId },
+    select: {
+      status: true,
+      class: true,
+      deletedAt: true,
+      subscription: { select: { planKey: true } },
+    },
+  });
+  if (!isPayingRow(row, row.subscription?.planKey ?? null)) return 0;
+  const amountDelta = roundMoney(Number(d.priceSnapshot) * d.deltaQty);
+  const type: BillingEventType =
+    d.deltaQty > 0 ? BILLING_EVENTS.ADDON_ENABLED : BILLING_EVENTS.ADDON_DISABLED;
+  await events.emit(
+    d.tenantId,
+    type,
+    { sku: d.sku, ...(d.payload ?? {}) },
+    { amountDelta, actorId: d.actorId, tx },
+  );
+  return amountDelta;
+}
```

## Call sites

**AddonDelta** (defined in apps/api/src/billing/addon-ledger.ts):
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md:132:export interface AddonDelta {
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md:150: d: AddonDelta,

**emitAddonDelta** (defined in apps/api/src/billing/addon-ledger.ts):
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md:147:export async function emitAddonDelta(
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md:220: await emitAddonDelta(tx, this.events, {
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md:239: await emitAddonDelta(tx, this.events, {
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md:256: await emitAddonDelta(tx, this.events, {
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md:270:`disableAddon` (:1318-1329): delete the `version`/`skuDef`/`monthly` catalog read; inside the tx replace the ADDON_DISABLED emit with `await emitAddonDelta(tx, this.events, { tenantId, sku: code, priceSnapshot: addon.priceSnapshot, deltaQty: -addon.quantity, actorId });` (SEAT_FREED unchanged).
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/cause-ruling.md:20:- **B865** — ONE add-on ledger helper (`emitAddonDelta(tx, tenant, sku, snapshot, deltaQty)` or equivalent):
.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/test-plan.md:25:| T14 | `REG-B865-LEDGER emitAddonDelta books ±snapshot×deltaQty only for a paying row` | new `addon-ledger.spec.ts`; stub `tx` with `$queryRaw`, `tenant.findUniqueOrThrow`; stub `events.emit` | paying + deltaQty 2, snapshot 12 → emit `amountDelta: 24`, `tx` forwarded; TRIAL → no emit; deltaQty 0 → no emit; snapshot null → no emit; `$queryRaw` called BEFORE `findUniqueOrThrow` (mock.invocationCallOrder) | `Cannot find module './addon-ledger'` (file this plan CREATES) | `apps/api/src/billing/addon-ledger.spec.ts` (new) |
apps/api/src/billing/addon.service.spec.ts:84: /** B865 / SA-277: the tenant row `emitAddonDelta` reads INSIDE the tx to decide whether an
apps/api/src/billing/addon.service.spec.ts:515:// the ONE add-on ledger helper (`emitAddonDelta`, `addon-ledger.ts`, FIX-865A): the row is
apps/api/src/billing/subscription-mutation.service.spec.ts:863:// the ONE add-on ledger helper (`emitAddonDelta`, `addon-ledger.ts`, FIX-865A/C) — see the

## Radius

**AddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md around line 132:

```
127: import { roundMoney } from "@routeflow/pricing";
128: import { BillingEventService } from "./billing-event.service";
129: import { BILLING_EVENTS, type BillingEventType } from "./plan-catalog.constants";
130: import { isPayingRow } from "./mrr.service";
131:
132: export interface AddonDelta {
133:   tenantId: string;
134:   sku: string; // catalog SKU code (caller bridges a legacy addonKey)
135:   priceSnapshot: unknown; // the STORED TenantAddon.priceSnapshot — never a live catalog read on disable
136:   deltaQty: number; // +qty enabled / −qty disabled; 0 emits nothing
137:   actorId?: string | null;
138:   payload?: Prisma.InputJsonObject;
139: }
140:
141: /**
142:  * B865 / SA-277 — the single add-on ledger writer (L-167): every enable/disable site books through here INSIDE
```

**AddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md around line 150:

```
145:  * Returns the amountDelta booked (0 when gated).
146:  */
147: export async function emitAddonDelta(
148:   tx: Prisma.TransactionClient,
149:   events: BillingEventService,
150:   d: AddonDelta,
151: ): Promise<number> {
152:   if (d.deltaQty === 0 || d.priceSnapshot == null) return 0;
153:   await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${d.tenantId} FOR UPDATE`;
154:   const row = await tx.tenant.findUniqueOrThrow({
155:     where: { id: d.tenantId },
156:     select: {
157:       status: true,
158:       class: true,
159:       deletedAt: true,
160:       subscription: { select: { planKey: true } },
```

**emitAddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md around line 147:

```
142:  * B865 / SA-277 — the single add-on ledger writer (L-167): every enable/disable site books through here INSIDE
143:  * its tx — lock the tenant row (SA-163), read the paying-set inputs under it, emit ±priceSnapshot × deltaQty
144:  * ONLY for a paying row. A TRIAL tenant's add-on is booked once, at activation, from the same stored snapshot.
145:  * Returns the amountDelta booked (0 when gated).
146:  */
147: export async function emitAddonDelta(
148:   tx: Prisma.TransactionClient,
149:   events: BillingEventService,
150:   d: AddonDelta,
151: ): Promise<number> {
152:   if (d.deltaQty === 0 || d.priceSnapshot == null) return 0;
153:   await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${d.tenantId} FOR UPDATE`;
154:   const row = await tx.tenant.findUniqueOrThrow({
155:     where: { id: d.tenantId },
156:     select: {
157:       status: true,
```

**emitAddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md around line 220:

````
215:       stripePriceId: stripePriceId ?? undefined,
216:       stripeItemId: stripeItemId ?? undefined,
217:       priceSnapshot,
218:     },
219:   });
220:   await emitAddonDelta(tx, this.events, {
221:     tenantId,
222:     sku,
223:     priceSnapshot,
224:     deltaQty: row.quantity ?? 1,
225:   });
226:   return row;
227: });
228: ```
229:
230: ("already active" ConflictException stays → deltaQty is the full qty.) In `disableAddon`, after the Stripe delete:
````

**emitAddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md around line 239:

````
234:   const row = await tx.tenantAddon.update({
235:     where: { tenantId_addonKey: { tenantId, addonKey } },
236:     data: { active: false, stripeItemId: null },
237:   });
238:   if (addon.active) {
239:     await emitAddonDelta(tx, this.events, {
240:       tenantId,
241:       sku: LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey,
242:       priceSnapshot: addon.priceSnapshot,
243:       deltaQty: -addon.quantity,
244:     });
245:   }
246:   return row;
247: });
248: ```
249:
````

**emitAddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md around line 256:

````
251:
252: `subscription-mutation.service.ts` `enableAddon` (:1259-1265) — replace the ADDON_ENABLED emit:
253:
254: ```ts
255: if (deltaQty !== 0) {
256:   await emitAddonDelta(tx, this.events, {
257:     tenantId,
258:     sku,
259:     priceSnapshot: skuDef.monthlyPrice,
260:     deltaQty,
261:     actorId,
262:     payload: { quantity: qty, prorated: preview.proratedToday },
263:   });
264:   if (sku === "SEAT_EXTRA" && priorQty === 0) {
265:     /* SEAT_ADDED emit unchanged */
266:   }
````

**emitAddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md around line 270:

````
265:     /* SEAT_ADDED emit unchanged */
266:   }
267: }
268: ```
269:
270: `disableAddon` (:1318-1329): delete the `version`/`skuDef`/`monthly` catalog read; inside the tx replace the ADDON_DISABLED emit with `await emitAddonDelta(tx, this.events, { tenantId, sku: code, priceSnapshot: addon.priceSnapshot, deltaQty: -addon.quantity, actorId });` (SEAT_FREED unchanged).
271:
272: ### RP-865A — revert probe addon-ledger
273:
274: Revert `addon-ledger.ts`; T14 must go red.
275:
276: ### RP-865B — revert probe addon.service
277:
278: Revert `addon.service.ts`; T8 must go red.
279:
280: ### RP-865C — revert probe subscription-mutation
````

**emitAddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/cause-ruling.md around line 20:

```
15:   selects periodStart/periodEnd for those rows. Stripe/catalog rows keep `addCycle` calendar clamping.
16:   Out of scope: proration of non-30/365 manual rows (proration.service :167/:211) → file as its own bug.
17: - **B864** — Option A: keep the in-tx snapshot write; gate the EMIT on `isPayingRow`, reading status/class/deletedAt
18:   inside the same tx under the tenant row lock (FOR UPDATE, SA-163 shape) so an activation racing the override can
19:   never book twice; actorId preserved. Option B (delete backfill, rely on post-commit reconcilePriceLedger) REJECTED.
20: - **B865** — ONE add-on ledger helper (`emitAddonDelta(tx, tenant, sku, snapshot, deltaQty)` or equivalent):
21:   snapshot = catalog SKU monthlyPrice; gate on `isPayingRow` inside the tx; book ±priceSnapshot × deltaQty from the
22:   STORED snapshot. Used by admin enableAddon (new $transaction), admin disableAddon (−snapshot × qty), AND the two
23:   self-serve sites (subscription-mutation :1259-1265, :1324-1329). Widening bounded to routing those four call sites.
24:   A stripePriceId with no catalog SKU → 400 (fail closed). Verify whether admin web ever sends stripePriceId; state it
25:   in the PR.
26: - **B866** — `byPlan[].baseMrr` gross (same as top level); byPlan.tenants stays rowPrice > 0; byPlan.baseMrr sums the
27:   same payingWhere rows as the top level. Identity pinned: mrr = Σ rowPrice = baseMrr(gross) − discountTotal +
28:   addonMrr. Verify getStats forwards byPlan before calling it "API-visible only".
29:
30: ## 3. Regression tests / pins (flip on SA-277)
```

**emitAddonDelta** in .claude/pipeline/2026-09-25-f51-billing-mrr-ledger/test-plan.md around line 25:

```
20: | T9  | `REG-B865-ADMIN priced enable on a TRIAL tenant writes the snapshot but books nothing`                                    | T8 with `tenantRow.status:"TRIAL"`                                                                                                                                                                                                                                                                                                                                                                     | `create.priceSnapshot === 10`; `emit` deltas `toEqual([])`                                                                                                                                                          | `Expected: 10 Received: undefined`                                          | same                                                         |
21: | T10 | `REG-B865-ADMIN disable books −priceSnapshot×qty from the STORED snapshot`                                                | `existingAddon:{id:"addon1",addonKey:"REGULATED_ITEMS",active:true,priceSnapshot:10,quantity:2,stripeItemId:null}`, paying tenantRow; `disableAddon("t1","REGULATED_ITEMS")`                                                                                                                                                                                                                           | `emit` called with `"addon.disabled"`, `amountDelta: -20`                                                                                                                                                           | `Expected: [-20] Received: []` (assert on the deltas array)                 | same                                                         |
22: | T11 | `REG-B865-ADMIN a stripePriceId whose key has no catalog SKU is a 400 before Stripe`                                      | stripe configured + `create` mock, `subscription:{stripeSubId:"sub_1"}`, `publishedSkus:[]`; `enableAddon("t1","not_in_catalog","price_x")`                                                                                                                                                                                                                                                            | `rejects.toBeInstanceOf(BadRequestException)`; `create` not called; `upsert` not called                                                                                                                             | `Received promise resolved instead of rejected`                             | same                                                         |
23: | T12 | `REG-B865-SELF TRIAL tenant enabling CUSTOMER_PACK_100 ×2 books nothing (activation books it once)`                       | `make({ tenantStatus:"TRIAL" })` with the tx-mock additions in Harness notes; `enableAddon("t1","CUSTOMER_PACK_100",2,"admin")`                                                                                                                                                                                                                                                                        | `tx.tenantAddon.upsert` create/update `priceSnapshot: 12`; `emit` deltas `toEqual([])`                                                                                                                              | `Expected: [] Received: [24]`                                               | `apps/api/src/billing/subscription-mutation.service.spec.ts` |
24: | T13 | `REG-B865-SELF disable books −stored snapshot, not −catalog`                                                              | paying tx tenantRow; `addonRow:{id:"a1",addonKey:"CUSTOMER_PACK_100",sku:"CUSTOMER_PACK_100",quantity:2,active:true,priceSnapshot:9}` (catalog says 12)                                                                                                                                                                                                                                                | `deltaOf(events,"addon.disabled") === -18`                                                                                                                                                                          | `Expected: -18 Received: -24`                                               | same                                                         |
25: | T14 | `REG-B865-LEDGER emitAddonDelta books ±snapshot×deltaQty only for a paying row`                                           | new `addon-ledger.spec.ts`; stub `tx` with `$queryRaw`, `tenant.findUniqueOrThrow`; stub `events.emit`                                                                                                                                                                                                                                                                                                 | paying + deltaQty 2, snapshot 12 → emit `amountDelta: 24`, `tx` forwarded; TRIAL → no emit; deltaQty 0 → no emit; snapshot null → no emit; `$queryRaw` called BEFORE `findUniqueOrThrow` (mock.invocationCallOrder) | `Cannot find module './addon-ledger'` (file this plan CREATES)              | `apps/api/src/billing/addon-ledger.spec.ts` (new)            |
26: | T15 | `REG-B866-BYPLAN byPlan baseMrr is gross (flips :78 "net of discounts", SA-277)`                                          | default `make()`                                                                                                                                                                                                                                                                                                                                                                                       | `byPlan` `toEqual([{planKey:"BUSINESS",tenants:1,baseMrr:349},{planKey:"STARTER",tenants:1,baseMrr:59}])`                                                                                                           | `Expected: 349 Received: 339`                                               | `apps/api/src/billing/mrr.service.spec.ts`                   |
27: | T16 | `REG-B866-BYPLAN 6-tenant fixture: SCALE 998 + identity (flips REG-MRR-ANNUAL, SA-277)`                                   | the existing REG-MRR-ANNUAL fixture                                                                                                                                                                                                                                                                                                                                                                    | SCALE `{tenants:1,baseMrr:998}`; `o.mrr === roundMoney(o.baseMrr - o.discountTotal + o.addonMrr)`; `Σ byPlan.baseMrr === o.baseMrr` (1346)                                                                          | `Expected: 998 Received: 499`                                               | same                                                         |
28:
29: Old pins REG-ROLL-MANUAL-ANNUAL, REG-OVERRIDE-BACKFILL-TRIAL, REG-ADMIN-ADDON-MRR, REG-MRR-ANNUAL and the :1144
30: "price-override back-fills … emits" test and :78 "net of discounts" are REPLACED in place by the rows above (delete
31: the old `it`, keep the legacy token in the new title). No other 7c3a5d61 pin is touched.
32:
33: ## Pins (no REG token; outside the red gate)
34:
35: | T#  | Frozen behavior                                                                                                                                                                                                                                                                                                  | File                       |
```

**emitAddonDelta** in apps/api/src/billing/addon.service.spec.ts around line 84:

```
79:   /** B524 fix round: `authority.assertFeatureRequiresMet` is a jest.fn() resolving/rejecting
80:    *  per this — the requires LOGIC itself now lives in
81:    *  `entitlement-authority.requires.spec.ts`, so this suite only needs to prove AddonService
82:    *  calls the shared check with the right (translated) key and surfaces its rejection. */
83:   assertFeatureRequiresMet?: jest.Mock;
84:   /** B865 / SA-277: the tenant row `emitAddonDelta` reads INSIDE the tx to decide whether an
85:    *  enable/disable books a ledger delta (status/class/deletedAt/subscription.planKey — the
86:    *  `isPayingRow` shape). Defaults to a paying (ACTIVE/PRODUCTION) row so the pre-existing
87:    *  priced-enable pins (T8/T9/T15, B342) keep booking unless a test overrides it. */
88:   tenantRow?: any;
89: }
90:
91: function make(opts: Opts = {}) {
92:   const prisma = {
93:     tenant: {
94:       findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }),
```

**emitAddonDelta** in apps/api/src/billing/addon.service.spec.ts around line 515:

```
510:   });
511: });
512:
513: // B865 / SA-277: the admin add-on path wrote no `priceSnapshot` and never booked a ledger
514: // delta at all — see cause-ruling.md SA-277. `enableAddon`/`disableAddon` now route through
515: // the ONE add-on ledger helper (`emitAddonDelta`, `addon-ledger.ts`, FIX-865A): the row is
516: // upserted inside a tx, the STORED snapshot is written explicitly (0 for a free grant — D1),
517: // and the emit is gated on `isPayingRow` read under the tenant lock inside the SAME tx.
518: describe("AddonService.enableAddon/disableAddon — B865 ledger (SA-277)", () => {
519:   it("REG-B865-ADMIN priced enable writes priceSnapshot and books +10 for a paying tenant (flips REG-ADMIN-ADDON-MRR, SA-277)", async () => {
520:     const create = jest.fn().mockResolvedValue({ id: "si_9" });
521:     const { svc, prisma, events } = make({
522:       stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
523:       subscription: { stripeSubId: "sub_1" },
524:       publishedSkus: ["REGULATED_ITEMS"],
525:       tenantRow: {
```

**emitAddonDelta** in apps/api/src/billing/subscription-mutation.service.spec.ts around line 863:

```
858: });
859:
860: // B865 / SA-277: the self-serve add-on paths emitted for ANY tenant status (a TRIAL tenant's
861: // add-on booked immediately, then booked AGAIN at activation) and `disableAddon` credited the
862: // LIVE catalog price instead of the row's own stored snapshot. Both sites now route through
863: // the ONE add-on ledger helper (`emitAddonDelta`, `addon-ledger.ts`, FIX-865A/C) — see the
864: // matching admin-path tests in `addon.service.spec.ts`.
865: describe("SubscriptionMutationService.enableAddon/disableAddon — B865 ledger gating (SA-277)", () => {
866:   it("REG-B865-SELF TRIAL tenant enabling CUSTOMER_PACK_100 ×2 books nothing (activation books it once)", async () => {
867:     const { svc, tx, events } = make({ tenantStatus: "TRIAL" });
868:
869:     await svc.enableAddon("t1", "CUSTOMER_PACK_100", 2, "admin");
870:
871:     expect(tx.tenantAddon.upsert).toHaveBeenCalledWith(
872:       expect.objectContaining({
873:         create: expect.objectContaining({ priceSnapshot: 12 }),
```
