# Build plan: F51 — B863/B864/B865/B866 billing & MRR ledger (SA-277)

> S5 bugfix. Fable @ high, 2026-09-25. Status: DRAFT. Inputs: cause-ruling.md (SA-277, FIXED), refutation.md,
> cause-brief.md, [test-plan.md](./test-plan.md). This file is the ONLY context agents get.

## Objective

B863 manual activation never writes `cycle` (365-day row rolls +1mo). B864 override on a TRIAL tenant books +monthly, activation books it again. B865 admin add-on path writes no `priceSnapshot`/no emit; self-serve emits ungated; disable books −catalog. B866 `byPlan[].baseMrr` net vs top-level gross.
**Out of scope:** non-30/365 proration (own bug); whether prepaid rows roll (B327); data repair (none); B868/B869.

## Constraints

- Jest config lives in `apps/api/package.json` (rootDir `src`; `*.db.spec.ts` only via `jest.db.config.js`, never run by the engine). Prettier: double quotes, width 100.
- `roundMoney` on every `amountDelta`. Paying gate ONLY via `isPayingRow` (`billing/mrr.service.ts`, L-167; grep-pinned by `mrr-paying-predicate.parity.spec.ts`).
- Lock shape (SA-163) = `platform-admin.service.ts:483` (`$queryRaw … FOR UPDATE` → read → decide). Lock order: Tenant row FIRST, then TenantAddon/TenantSubscription writes.
- Must NOT change: `rollCycles` `where` (pinned), `addCycle`, `BillingEventService.emit`, `billing.module.ts` (all three services co-provided :43-50; helper is a plain function), DTOs, schema. No migration.
- PR must state: `getStats()` forwards only `mrr`/`ledgerMrr` (`byPlan` visible only via `GET billing/admin/mrr`); admin web `EnableAddonModal` DOES optionally send `stripePriceId` (test :83), so the new 400 is UI-reachable. No live tenant identifiers.

## Decisions taken here (raise to SA, do not re-litigate in-engine)

- **D1 — RULED SA-277a:** a free admin grant (no `stripePriceId`) writes `priceSnapshot: 0` EXPLICITLY and emits nothing ("priced, at nothing" to every reader). Pin: grant without stripePriceId → snapshot 0, no ledger row, add-on MRR 0. Priced branch → catalog SKU monthlyPrice snapshot + gated emit. (Session note: SA-277a's rationale that mrr.service re-prices a null snapshot from the catalog is false — `priceSubscription` mrr.service.ts:303-306 prices null at $0; the ruling stands as the explicit form.)
- **D2 — RULED SA-277a (SA-E23):** BOTH `activateManualSubscription` and `updateTenantPriceOverride` take `SELECT id FROM "Tenant" WHERE id = $1 FOR UPDATE` as the FIRST statement of their tx (same lock as updateTenantClass). House order: tenant row lock → subscription rows → ledger inserts. A statement-order SOURCE/CALL-ORDER pin on both methods: assert on the mocked tx that `$queryRaw` (the lock) is called before any `tenantSubscription.*` call and before `billingEventService.emit`, via jest `mock.invocationCallOrder` (testing/op-log-tx.ts from #2152 is NOT on master — do not import it).
- **D3 — RULED SA-277a:** the 400 is reachable from the admin EnableAddonModal (it optionally sends stripePriceId), so its message is user-facing copy; the modal already renders `response.data.message` (EnableAddonModal.tsx:94-103) — task UI-865 pins that.

## Tasks

### RC-863 — confirm B863 cause

`platform-admin.service.ts:963-995` no `cycle:` in either upsert branch; `billing-cron.service.ts:484-498` selects no periodStart/externalPayment, calls `addCycle(start, s.cycle)`. Probe: `cd apps/api && npx jest src/billing/billing-cron.service.spec.ts -t "REG-ROLL-MANUAL-ANNUAL"` green today.

### RT-863 — repro tests T1-T5, P1, P2

Author test-plan T1/T2 inside the :2163 describe of `platform-admin.service.spec.ts`; in `billing-cron.service.spec.ts` replace the REG-ROLL-MANUAL-ANNUAL `it` with T3 and add T4/T5/P1/P2 (comment cites SA-277). wrongValue: `undefined` (T1/T2), `2026-02-01T00:00:00.000Z` (T3-T5).

### FIX-863 — cycle on manual activation + length-preserving external roll

`activateManualSubscription`, after `const periodEnd = …`:

```ts
// B863 / SA-277: 365-day prepaid = ANNUAL, shorter = MONTHLY; external rows roll length-preserving (rollCycles).
const cycle: "MONTHLY" | "ANNUAL" = dto.billingPeriodDays >= 365 ? "ANNUAL" : "MONTHLY";
```

Add `cycle,` to BOTH `create` and `update` of the upsert (:965-994). In `rollCycles` (:484-498):

```ts
select: { tenantId: true, cycle: true, periodStart: true, periodEnd: true, externalPayment: true },
// …
const start = s.periodEnd as Date;
// B863 / SA-277: an external (prepaid) row rolls by its OWN prior length (start := old end, end := start + prior
// length); Stripe/catalog rows keep addCycle's calendar clamping (B329 note above).
const priorMs = s.periodStart ? start.getTime() - s.periodStart.getTime() : 0;
const periodEnd =
  s.externalPayment && priorMs > 0 ? new Date(start.getTime() + priorMs) : addCycle(start, s.cycle);
await this.prisma.tenantSubscription.update({ where: { tenantId: s.tenantId }, data: { periodStart: start, periodEnd } });
```

### RP-863 — revert probe billing-cron

Revert `billing-cron.service.ts`; T3 must go red.

### RC-864 — confirm B864 cause

`platform-admin.service.ts:1439-1461`: no status/class read, emit unconditional; `reconcilePriceLedger` no-ops (snapshot already 1200); activation :1001-1037 emits +1200 again. Probe: `-t "REG-OVERRIDE-BACKFILL-TRIAL"` green today.

### RT-864 — repro tests T6, T7, P3, P4

In `platform-admin.service.spec.ts` replace :1144 and the REG-OVERRIDE-BACKFILL-TRIAL `it` with T6/P3; add T7 (reuse the :2163 describe's catalog/`tenant.update` fixture values). wrongValue: `[1200]` (T6), `2400` (T7).

### FIX-864 — gate the override emit in-tx under the tenant lock; lock activation too

Replace the `$transaction` body of `updateTenantPriceOverride` (:1441-1463):

```ts
await this.prisma.$transaction(async (tx) => {
  // B864 / SA-277 (SA-163 shape): lock → read paying-set inputs → decide; a racing activation serialises here.
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
  // Re-read the subscription UNDER the lock: backfillBase must be decided from the locked row, not
  // from `existing` read before the tx (a racing activation could have written the snapshot).
  const row = await tx.tenant.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      class: true,
      deletedAt: true,
      subscription: { select: { planKey: true } },
    },
  });
  await tx.tenantSubscription.upsert({/* unchanged */});
  // Snapshot written regardless; ONLY the emit is gated — a non-paying tenant books once, at activation.
  if (backfillBase && isPayingRow(row, row.subscription?.planKey ?? null)) {
    await this.billingEventService.emit(
      id,
      BILLING_EVENTS.PLAN_CHANGED,
      { toPlan: existing.planKey, platformAdmin: true, priceOverrideBackfill: true },
      { amountDelta: roundMoney(dto.monthly!), actorId: adminId, tx },
    );
  }
});
```

Fix the :1432-1435 comment (a set snapshot IS rewritten by `reconcilePriceLedger`). In `activateManualSubscription`'s tx (:938) insert as the FIRST statement:

```ts
// B864 / SA-277 (D2): same tenant row lock as updateStatus/updateTenantClass/updateTenantPriceOverride.
await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${id} FOR UPDATE`;
```

### RP-864 — revert probe platform-admin

Revert `platform-admin.service.ts`; T6 must go red (T1/T2 too — same file, expected).

### RC-865 — confirm B865 cause

`addon.service.ts:246-260` no `priceSnapshot`, no BillingEventService (ctor :48-55), no tx. `subscription-mutation.service.ts:1259-1265,:1324-1329` emit for any tenant; :1322 books −catalog. Probe: `-t "REG-ADMIN-ADDON-MRR"` green today.

### RT-865 — repro tests T8-T14, P5-P7

`addon.service.spec.ts`: replace REG-ADMIN-ADDON-MRR with T8; add T9-T11, P5, P6 + the harness edits (test-plan). `subscription-mutation.service.spec.ts`: T12, T13, P7 + harness edits. NEW `apps/api/src/billing/addon-ledger.spec.ts`: T14 (imports `./addon-ledger`, created by FIX-865A). wrongValues: `undefined` (T8/T9), `[]` (T10), `resolved` (T11), `[24]` (T12), `-24` (T13).

### FIX-865A — the ONE add-on ledger helper (new file)

`apps/api/src/billing/addon-ledger.ts` (CREATED; no DI):

```ts
import { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { BillingEventService } from "./billing-event.service";
import { BILLING_EVENTS, type BillingEventType } from "./plan-catalog.constants";
import { isPayingRow } from "./mrr.service";

export interface AddonDelta {
  tenantId: string;
  sku: string; // catalog SKU code (caller bridges a legacy addonKey)
  priceSnapshot: unknown; // the STORED TenantAddon.priceSnapshot — never a live catalog read on disable
  deltaQty: number; // +qty enabled / −qty disabled; 0 emits nothing
  actorId?: string | null;
  payload?: Prisma.InputJsonObject;
}

/**
 * B865 / SA-277 — the single add-on ledger writer (L-167): every enable/disable site books through here INSIDE
 * its tx — lock the tenant row (SA-163), read the paying-set inputs under it, emit ±priceSnapshot × deltaQty
 * ONLY for a paying row. A TRIAL tenant's add-on is booked once, at activation, from the same stored snapshot.
 * Returns the amountDelta booked (0 when gated).
 */
export async function emitAddonDelta(
  tx: Prisma.TransactionClient,
  events: BillingEventService,
  d: AddonDelta,
): Promise<number> {
  if (d.deltaQty === 0 || d.priceSnapshot == null) return 0;
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${d.tenantId} FOR UPDATE`;
  const row = await tx.tenant.findUniqueOrThrow({
    where: { id: d.tenantId },
    select: {
      status: true,
      class: true,
      deletedAt: true,
      subscription: { select: { planKey: true } },
    },
  });
  if (!isPayingRow(row, row.subscription?.planKey ?? null)) return 0;
  const amountDelta = roundMoney(Number(d.priceSnapshot) * d.deltaQty);
  const type: BillingEventType =
    d.deltaQty > 0 ? BILLING_EVENTS.ADDON_ENABLED : BILLING_EVENTS.ADDON_DISABLED;
  await events.emit(
    d.tenantId,
    type,
    { sku: d.sku, ...(d.payload ?? {}) },
    { amountDelta, actorId: d.actorId, tx },
  );
  return amountDelta;
}
```

### FIX-865B — admin AddonService routes through the helper

`addon.service.ts`: ctor arg 7 `private readonly events: BillingEventService` (same module, no module change). In `enableAddon` replace the `const sku = LEGACY_ADDON_KEY_TO_SKU[addonKey]; if (sku) {…}` block:

```ts
const sku = LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey;
const published = await this.catalog.getPublishedCatalog();
const skuDef = published.addonSkus.find((s) => s.sku === sku);
if (LEGACY_ADDON_KEY_TO_SKU[addonKey] && !skuDef)
  throw new BadRequestException(/* existing message */);
// B865 / SA-277: a billed add-on must be priceable from the catalog — fail closed BEFORE any Stripe write.
if (stripePriceId && !skuDef) {
  throw new BadRequestException(
    `Add-on "${addonKey}" has no catalog SKU to price — publish a catalog version defining "${sku}" before billing it`,
  );
}
// D1 (SA-277a): only a Stripe-billed enable carries revenue; a free grant is priced EXPLICITLY at 0 and books nothing.
const priceSnapshot = stripePriceId && skuDef ? Number(skuDef.monthlyPrice) : 0;
```

Stripe item create unchanged. Replace the bare upsert with a tx:

```ts
const addon = await this.prisma.$transaction(async (tx) => {
  const row = await tx.tenantAddon.upsert({
    where: { tenantId_addonKey: { tenantId, addonKey } },
    create: {
      tenantId,
      addonKey,
      sku,
      stripePriceId: stripePriceId ?? null,
      stripeItemId,
      active: true,
      priceSnapshot,
    },
    update: {
      active: true,
      sku,
      stripePriceId: stripePriceId ?? undefined,
      stripeItemId: stripeItemId ?? undefined,
      priceSnapshot,
    },
  });
  await emitAddonDelta(tx, this.events, {
    tenantId,
    sku,
    priceSnapshot,
    deltaQty: row.quantity ?? 1,
  });
  return row;
});
```

("already active" ConflictException stays → deltaQty is the full qty.) In `disableAddon`, after the Stripe delete:

```ts
const updated = await this.prisma.$transaction(async (tx) => {
  const row = await tx.tenantAddon.update({
    where: { tenantId_addonKey: { tenantId, addonKey } },
    data: { active: false, stripeItemId: null },
  });
  if (addon.active) {
    await emitAddonDelta(tx, this.events, {
      tenantId,
      sku: LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey,
      priceSnapshot: addon.priceSnapshot,
      deltaQty: -addon.quantity,
    });
  }
  return row;
});
```

### FIX-865C — self-serve sites route through the helper

`subscription-mutation.service.ts` `enableAddon` (:1259-1265) — replace the ADDON_ENABLED emit:

```ts
if (deltaQty !== 0) {
  await emitAddonDelta(tx, this.events, {
    tenantId,
    sku,
    priceSnapshot: skuDef.monthlyPrice,
    deltaQty,
    actorId,
    payload: { quantity: qty, prorated: preview.proratedToday },
  });
  if (sku === "SEAT_EXTRA" && priorQty === 0) {
    /* SEAT_ADDED emit unchanged */
  }
}
```

`disableAddon` (:1318-1329): delete the `version`/`skuDef`/`monthly` catalog read; inside the tx replace the ADDON_DISABLED emit with `await emitAddonDelta(tx, this.events, { tenantId, sku: code, priceSnapshot: addon.priceSnapshot, deltaQty: -addon.quantity, actorId });` (SEAT_FREED unchanged).

### RP-865A — revert probe addon-ledger

Revert `addon-ledger.ts`; T14 must go red.

### RP-865B — revert probe addon.service

Revert `addon.service.ts`; T8 must go red.

### RP-865C — revert probe subscription-mutation

Revert `subscription-mutation.service.ts`; T12 must go red.

### RC-866 — confirm B866 cause

`mrr.service.ts:242` `baseMrr += base;` vs `:249` `… + base - discount` — same loop, same inputs. Probe: `-t "breaks MRR down by plan"` green at 339.

### RT-866 — repro tests T15, T16, P8

`mrr.service.spec.ts`: rewrite :74-80 as T15; in REG-MRR-ANNUAL replace the SCALE assertion + its NOTE with T16 (998, identity, Σ byPlan = baseMrr) citing SA-277. wrongValues: `339`, `499`.

### FIX-866 — byPlan gross

`mrr.service.ts:249` →

```ts
// B866 / SA-277: gross — the SAME formula as the top-level baseMrr accumulator (L-119).
// Identity: mrr = Σ rowPrice = baseMrr − discountTotal + addonMrr; Σ byPlan.baseMrr = baseMrr.
row.baseMrr = roundMoney(row.baseMrr + base);
```

Update the `MrrPlanRow.baseMrr` doc comment ("gross base run-rate, before discounts"). `byPlan.tenants` unchanged.

### RP-866 — revert probe mrr.service

Revert `mrr.service.ts`; T15 must go red.

### UI-865 — admin EnableAddonModal shows the no-catalog-SKU 400 (SA-277a)

Test-only unless it fails: add one RTL case to `EnableAddonModal.test.tsx` — the enable call rejects with `{response:{data:{message:'Add-on "X" has no catalog SKU to price — publish a catalog version defining "X" before billing it'}}}` → that exact text is rendered in the modal's error region, the modal stays open, and the submit button is re-enabled. If the modal already passes (it renders `response.data.message`, :94-103), change NO source file. Run: `npm test -w apps/web -- EnableAddonModal --maxWorkers=2`.

### DBT-F51 — NEED-DB spec (authored here, run by the F2 prover, never in engine gates)

Create `apps/api/src/common/override-activation-ledger.db.spec.ts` per test-plan "NEED-DB lane" (DB1, DB2); header `NEED-DB: run by the F2 prover, not in engine gates`. Pattern: `apps/api/src/common/update-tenant-class-ledger.db.spec.ts` (17 ctor args, that order). `afterAll` deletes its tenants. Do NOT run it.

## Acceptance criteria

1. B863 both upsert branches write `cycle` (30→MONTHLY, 365→ANNUAL); external rows roll by prior length; Stripe rows unchanged.
2. B864 non-paying override writes the snapshot, emits nothing; activation books +1200 exactly once; both under `FOR UPDATE`.
3. B865 four sites → one helper; priced admin enable snapshots + gated emit; disables book −stored snapshot; unpriceable `stripePriceId` → 400 before Stripe; D1 in the PR.
4. B866 `Σ byPlan.baseMrr === baseMrr`; `mrr === baseMrr − discountTotal + addonMrr` (408/1346 fixtures).
5. No module/DTO/schema/`rollCycles`-`where` change; no live catalog read in any disable path.

## Risks & rollback

D1 wrong → one-line flip in FIX-865B. Lock-order deadlock → helper locks Tenant FIRST; reviewer checks each site. B342 fixtures (`ai_scanning`+`price_1`, no SKU) now 400 → harness note. Rollback: revert the squash; no migration/data repair (the one live B863-shaped row is class TEST/planKey NULL, excluded from `rollCycles`). Observability: `apps/api/scripts/report-mrr-ledger-drift.mjs`.

## Pipeline args

```js
{
  buildPlanPath: '.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-25-f51-billing-mrr-ledger/test-plan.md',
  runDir: '.claude/pipeline/2026-09-25-f51-billing-mrr-ledger',
  scriptsDir: '/Users/maznahamanullah/.claude/skills/dev-pipeline/scripts',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '<ISO at launch>',
  scale: 'major', mode: 'bugfix', profile: 'standard',
  workdir: '/Users/maznahamanullah/code/routeflow/.claude/worktrees/zealous-franklin-2c1741',
  context: 'F51 B863-B866 billing/MRR ledger fixes per SA-277; four bugs, one add-on ledger helper',
  siblingPatterns: [
    { pattern: '(billingEventService|this\\.events)\\.emit\\(', note: 'every ledger emit with amountDelta must be isPayingRow-gated or inside a pre-scoped cron/webhook path' },
    { pattern: 'amountDelta:', note: 'signed MRR deltas not derived from a STORED snapshot or not routed through isPayingRow' },
    { pattern: 'addCycle\\(', note: 'callers on external/prepaid rows must be length-preserving, not calendar-clamped' },
  ],
  tasks: [
    { id: 'RC-863', title: 'confirm B863 cause', type: 'root-cause', files: [], tests: [], dependsOn: [], risk: 'HIGH' },
    { id: 'RT-863', title: 'repro tests T1-T5, P1, P2', type: 'repro-test', files: [], tests: ['apps/api/src/platform-admin/platform-admin.service.spec.ts', 'apps/api/src/billing/billing-cron.service.spec.ts'], dependsOn: ['RC-863'], risk: 'HIGH' },
    { id: 'FIX-863', title: 'cycle on manual activation + length-preserving external roll', type: 'fix', files: ['apps/api/src/platform-admin/platform-admin.service.ts', 'apps/api/src/billing/billing-cron.service.ts'], tests: [], dependsOn: ['RC-863', 'RT-863'], risk: 'HIGH', radius: [8, 12] },
    { id: 'RP-863', title: 'revert probe billing-cron', type: 'revert-probe', file: 'apps/api/src/billing/billing-cron.service.ts', test: 'cd apps/api && npx jest src/billing/billing-cron.service.spec.ts -t "REG-B863-ROLL" --maxWorkers=2', dependsOn: ['FIX-863'], risk: 'HIGH' },
    { id: 'RC-864', title: 'confirm B864 cause', type: 'root-cause', files: [], tests: [], dependsOn: [], risk: 'HIGH' },
    { id: 'RT-864', title: 'repro tests T6, T7, P3, P4', type: 'repro-test', files: [], tests: ['apps/api/src/platform-admin/platform-admin.service.spec.ts'], dependsOn: ['RC-864', 'RT-863'], risk: 'HIGH' },
    { id: 'FIX-864', title: 'gate the override emit in-tx under the tenant lock; lock activation too', type: 'fix', files: ['apps/api/src/platform-admin/platform-admin.service.ts'], tests: [], dependsOn: ['RC-864', 'RT-864', 'FIX-863'], risk: 'HIGH', radius: [8, 12] },
    { id: 'RP-864', title: 'revert probe platform-admin', type: 'revert-probe', file: 'apps/api/src/platform-admin/platform-admin.service.ts', test: 'cd apps/api && npx jest src/platform-admin/platform-admin.service.spec.ts -t "REG-B864-TRIAL-OVERRIDE" --maxWorkers=2', dependsOn: ['FIX-864'], risk: 'HIGH' },
    { id: 'RC-865', title: 'confirm B865 cause', type: 'root-cause', files: [], tests: [], dependsOn: [], risk: 'HIGH' },
    { id: 'RT-865', title: 'repro tests T8-T14, P5-P7', type: 'repro-test', files: [], tests: ['apps/api/src/billing/addon.service.spec.ts', 'apps/api/src/billing/subscription-mutation.service.spec.ts', 'apps/api/src/billing/addon-ledger.spec.ts'], dependsOn: ['RC-865'], risk: 'HIGH' },
    { id: 'FIX-865A', title: 'the ONE add-on ledger helper (new file)', type: 'fix', files: ['apps/api/src/billing/addon-ledger.ts'], tests: [], dependsOn: ['RC-865', 'RT-865'], risk: 'HIGH', radius: [5, 10] },
    { id: 'FIX-865B', title: 'admin AddonService routes through the helper', type: 'fix', files: ['apps/api/src/billing/addon.service.ts'], tests: [], dependsOn: ['FIX-865A'], risk: 'HIGH', radius: [8, 12] },
    { id: 'FIX-865C', title: 'self-serve sites route through the helper', type: 'fix', files: ['apps/api/src/billing/subscription-mutation.service.ts'], tests: [], dependsOn: ['FIX-865A'], risk: 'HIGH', radius: [8, 12] },
    { id: 'RP-865A', title: 'revert probe addon-ledger', type: 'revert-probe', file: 'apps/api/src/billing/addon-ledger.ts', test: 'cd apps/api && npx jest src/billing/addon-ledger.spec.ts -t "REG-B865-LEDGER" --maxWorkers=2', dependsOn: ['FIX-865A'], risk: 'HIGH' },
    { id: 'RP-865B', title: 'revert probe addon.service', type: 'revert-probe', file: 'apps/api/src/billing/addon.service.ts', test: 'cd apps/api && npx jest src/billing/addon.service.spec.ts -t "REG-B865-ADMIN" --maxWorkers=2', dependsOn: ['FIX-865B'], risk: 'HIGH' },
    { id: 'RP-865C', title: 'revert probe subscription-mutation', type: 'revert-probe', file: 'apps/api/src/billing/subscription-mutation.service.ts', test: 'cd apps/api && npx jest src/billing/subscription-mutation.service.spec.ts -t "REG-B865-SELF" --maxWorkers=2', dependsOn: ['FIX-865C'], risk: 'HIGH' },
    { id: 'RC-866', title: 'confirm B866 cause', type: 'root-cause', files: [], tests: [], dependsOn: [], risk: 'HIGH' },
    { id: 'RT-866', title: 'repro tests T15, T16, P8', type: 'repro-test', files: [], tests: ['apps/api/src/billing/mrr.service.spec.ts'], dependsOn: ['RC-866'], risk: 'HIGH' },
    { id: 'FIX-866', title: 'byPlan gross', type: 'fix', files: ['apps/api/src/billing/mrr.service.ts'], tests: [], dependsOn: ['RC-866', 'RT-866'], risk: 'HIGH', radius: [5, 10] },
    { id: 'RP-866', title: 'revert probe mrr.service', type: 'revert-probe', file: 'apps/api/src/billing/mrr.service.ts', test: 'cd apps/api && npx jest src/billing/mrr.service.spec.ts -t "REG-B866-BYPLAN" --maxWorkers=2', dependsOn: ['FIX-866'], risk: 'HIGH' },
    { id: 'UI-865', title: 'admin EnableAddonModal shows the no-catalog-SKU 400 (SA-277a)', type: 'feature', files: [], tests: ['apps/web/app/(platform-admin)/admin/tenants/[id]/_features/EnableAddonModal.test.tsx'], dependsOn: ['FIX-865B'], risk: 'MEDIUM' },
    { id: 'DBT-F51', title: 'NEED-DB spec (authored here, run by the F2 prover, never in engine gates)', type: 'feature', files: ['apps/api/src/common/override-activation-ledger.db.spec.ts'], tests: [], dependsOn: ['FIX-864', 'FIX-865B', 'FIX-865C'], risk: 'HIGH' },
  ],
  verifyCommands: {
    perRound: [
      'npx tsc --noEmit -p apps/api/tsconfig.json',
      'cd apps/api && npx jest src/billing/billing-cron.service.spec.ts src/platform-admin/platform-admin.service.spec.ts src/billing/addon.service.spec.ts src/billing/subscription-mutation.service.spec.ts src/billing/mrr.service.spec.ts src/billing/addon-ledger.spec.ts src/billing/mrr-paying-predicate.parity.spec.ts --maxWorkers=2 --passWithNoTests',
    ],
    final: ['npm test -w apps/api -- --maxWorkers=2', 'npm run lint -w apps/api'],
  },
  formatCommand: "git ls-files -m -o --exclude-standard apps/api/src | grep -E '\\.ts$' | xargs -r npx prettier --write",  // changed files only — never the whole workspace (memory: engine format dirties ~130 files)
}
```

Red gate: test-plan "Commands". Commands verified: `apps/api/package.json` scripts `test`/`lint`/`format`, root `node_modules/.bin/jest`, `apps/api/tsconfig.json`. No root jest config — never `--selectProjects`.
