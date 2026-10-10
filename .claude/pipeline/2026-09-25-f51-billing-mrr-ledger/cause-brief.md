# S1 Evidence Brief — F51 billing/MRR ledger (B863–B866)

## B863 · Manual 365-day activation stored MONTHLY

**Bug as stated**: "activateManualSubscription writes periodEnd = now + billingPeriodDays but
never sets TenantSubscription.cycle, so the schema default MONTHLY stays even for a 365-day
payment; rollCycles then advances such a period by +1 month once it lapses." Repro:
`billingPeriodDays:365` → `periodEnd`+365d, `cycle` untouched → expected +365d roll; observed
(pinned) +1mo.

**Code path**: `activateManualSubscription`(`platform-admin.service.ts:898-1043`) →
`tx.tenantSubscription.upsert` **:963-995** — `create`(965-976)/`update`(977-994) list
`currentPlan/planKey/planVersionId/periodStart/periodEnd/externalPayment*`, no `cycle`. Schema:
`cycle BillingCycle @default(MONTHLY)`(`platform.prisma:47`); `billingInterval String?`(`:67`) is
Stripe-webhook-only(`billing.service.ts:629-841`), unwritten here. DTO `billingPeriodDays`: free
`@IsInt()@Min(1)`(`activate-subscription.dto.ts:30-33`); web offers 30/90/180/365d
(`.../[id]/page.tsx:740-745`), only 30/365 map to `BillingCycle`. `rollCycles`
(`billing-cron.service.ts:484-491`) selects `{periodEnd:{lt:now},planKey:{not:null},
cancelAtPeriodEnd:false}`(no status key) → `addCycle(start,s.cycle)`(`:497`) →
`billing-math.ts:105`: `cycle==="ANNUAL"?12:1` months.

**History**: upsert(963-995): `e4acb0ae8` 2026-09-18 "keep subscription+ledger in sync (B556,
B557)" — added the B864 emit, still no `cycle:`. `rollCycles` loop unchanged since `0f982de2b`
2026-07-08 "lifecycle crons". `addCycle` branch unchanged since `29fdf6a4f` 2026-09-13 "wave W1".

**Existing tests**: no pre-QA test asserts `cycle` in the upsert. New: REG-ROLL-MANUAL-ANNUAL
(`billing-cron.service.spec.ts`) — MONTHLY row rolls +1mo not +365d, "defect candidate".
REG-ROLL-NONACTIVE proves the `where` has no status key. Both mock `findMany` directly (not the
real query).

**Production evidence** (read-only QA): one live tenant ACTIVE, **planKey NULL**, cycle MONTHLY,
billingInterval NULL, periodStart 2026-09-01→periodEnd 2027-09-01(365d), externalPayment
true(CASH), basePriceSnapshot NULL. Since planKey is NULL, `planKey:{not:null}` **excludes this
row today** — frozen, not mis-rolling now. Comment `:905-908`: OLD code never wrote planKey —
likely pre-fix legacy. A NEW manual 365d activation today gets planKey set (REG-B557-MANUAL) and
would hit the +1mo roll live.

**Open unknowns**: prod query for other manual rows with planKey SET + cycle MONTHLY (the
live-buggy population); no BillingCycle value exists for the UI's 90/180-day options.

---

## B864 · Price override on non-paying tenant double-books the ledger

**Bug as stated**: "updateTenantPriceOverride backfills the snapshot AND emits PLAN_CHANGED
+monthly without the paying-set check (isPayingRow), so a TRIAL tenant is booked into the ledger
before it pays." Repro: TRIAL tenant, planKey set + basePriceSnapshot null; admin sets
`monthly:1200` → observed snapshot→1200, ledger +1200; expected no emit.

**Code path**: `updateTenantPriceOverride`(`platform-admin.service.ts:1414-1478`). Backfill gate
**:1439-1440**: `dto.monthly!=null && existing?.planKey!=null && existing.basePriceSnapshot==
null` — no status/class read in this method, no `isPayingRow` call. Emit **:1455-1462**:
`amountDelta:roundMoney(dto.monthly!)` unconditional. `isPayingRow`(`mrr.service.ts:25-37`:
status===ACTIVE && deletedAt==null && class===PRODUCTION && planKey!=null) IS called by 3 sibling
methods before their emits (see Sibling map). Double-book trace: override wrongly emits +1200 on
the TRIAL row; a later
`activateManualSubscription` reads `basePriceSnapshot=1200`(:953), `wasPaying=false`(TRIAL)→
`isPaying=true`, `contribution=priceSubscription({1200,0},[])=1200`(:1012-1018), emits another
+1200(:1029) — ledger totals +2400 vs run-rate 1200. `BillingEventService.emit`
(`billing-event.service.ts:15-36`) is a bare append, no idempotency key; `ledgerMrr`
(`mrr.service.ts:286`) sums every `amountDelta` ever emitted, permanently inflated.

**History**: backfill+emit(1439-1461): `b1a0e099e` 2026-08-24 "addon catalog validation,
self-service gate", unchanged since. `9a460cb1` 2026-09-24 "unify paying-set predicate, close two
MRR ledger gaps (B556, B557)" touched those 3 siblings — not this one.

**Existing tests**: pre-existing `platform-admin.service.spec.ts:1144-1165` ("price-override
back-fills … emits the run-rate delta") already asserts `amountDelta:1200` unconditionally, no
`status` in the fixture — a fix must update this test too. New REG-OVERRIDE-BACKFILL-TRIAL
(`7c3a5d61`) makes the TRIAL case explicit, same assertion.

**Production evidence**: registry's own local run only ("+1,200 ledger on a TRIAL Enterprise
tenant, MRR unchanged"); no prod report.

**Open unknowns**: how often a TRIAL tenant gets priced pre-activation; whether
`report-mrr-ledger-drift.mjs` already flags this tenant.

---

## B865 · Admin add-on priced in Stripe but invisible to MRR

**Bug as stated**: "The admin enableAddon path creates a real Stripe subscription item … but
never writes TenantAddon.priceSnapshot or emits a BillingEvent … the tenant self-serve path does
both." Repro: admin grants addon with `stripePriceId` → Stripe item created (real charge);
expected priceSnapshot set + ADDON_ENABLED emitted; observed neither.

**Code path**: admin `enableAddon`(`addon.service.ts:136-293`); constructor **:48-55** =
`prisma,stripe,entitlements,catalog,featureResolver,authority` — no `BillingEventService`. Stripe
item create **:224-242**. Upsert **:246-260**: `create:{tenantId,addonKey,stripePriceId,
stripeItemId,active}`/`update:{active,stripePriceId,stripeItemId}` — no `priceSnapshot`. Only
caller: `platform-admin.controller.ts:366` (`dto.stripePriceId` admin-supplied — reachable).
Self-serve `enableAddon`(`subscription-mutation.service.ts:1223-1304`) contrasts: prices via
catalog SKU(:1224-1225), upsert writes `priceSnapshot:skuDef.monthlyPrice`(:1255,1257), emits
`ADDON_ENABLED amountDelta:roundMoney(skuDef.monthlyPrice*deltaQty)`(:1260-1265); `disableAddon`
(:1307-1341) books `-monthly`(:1327). `MrrService.addonMrr` prices strictly off `priceSnapshot`
(`mrr.service.ts:176-185,219-244`) — null → $0(:239).

**History**: admin upsert(246-260): `29fdf6a4f` 2026-09-13 "wave W1 — money that is wrong today"
— a money-remediation wave, still no priceSnapshot.

**Existing tests**: pre-existing `addon.service.spec.ts` blocks (enableAddon:110,
disableAddon:151, Stripe refusal:228, B342:310, B524:416) never assert priceSnapshot/
BillingEvent — no `billingEvent` mock exists pre-QA. New REG-ADMIN-ADDON-MRR(`7c3a5d61`) names
the gap; its mock `prisma` has no `billingEvent` model, so clean resolution proves no emit runs.

**Production evidence**: registry states "production has no such rows today (latent)" — not
re-verified this pass.

**Open unknowns**: has any admin used `stripePriceId` in practice, or is it latent (free-grants
only); is `disableAddon` moot since enable never snapshots.

---

## B866 · Top-level baseMrr vs byPlan[].baseMrr disagree on discount

**Bug as stated**: "Top-level baseMrr accumulates base (no discount) while byPlan[plan].baseMrr
accumulates base − discount." Repro (existing fixture, unchanged since inception): BUSINESS
base=349 discount=10, STARTER base=59 discount=0 → observed top-level `baseMrr=408`(349+59, no
discount); observed `byPlan BUSINESS.baseMrr=339`(349−10).

**Code path**: `computeOverview` loop(`mrr.service.ts:234-266`). **:242** `baseMrr += base;`
(top-level, discount never subtracted, only final `roundMoney(baseMrr)` at :268). **:249**
`row.baseMrr = roundMoney(row.baseMrr + base - discount);` (byPlan, subtracts every iteration).
Both read the same `base`/`discount` from :235-236.

**History**: both lines 242 and 249 date to the SAME original commit `10dd718bf` 2026-07-08
"server-side MRR rollup + churn-aware ledger (P6)" — not a later refactor drifting one side;
disagreed since day one. Untouched since by `4bfebdb13`/`9a460cb1`.

**Existing tests**: `mrr.service.spec.ts:57-81`, unchanged since `10dd718bf`, already pins BOTH
values from the SAME fixture in two `it()` blocks: `:60 expect(o.baseMrr).toBe(408)` and `:78
{planKey:"BUSINESS",tenants:1,baseMrr:339}` — green, self-evidently inconsistent since day one;
unflagged until REG-MRR-ANNUAL(`7c3a5d61`, comment citing :242 vs :249, pinning byPlan SCALE to
the code-observed 499 not the QA plan's assumed 998).

**Production evidence**: none beyond "Found by REG-MRR-ANNUAL".

**Open unknowns**: repo-wide grep for `baseMrr`/`byPlan` (web/mobile/packages/scripts) found
**ZERO consumers** outside `mrr.service.ts` and its 2 spec files. `admin/billing/page.tsx`, the
only reader of `GET /billing/admin/mrr`(:89-92), declares its own local `interface MrrOverview`
(:53-63, not from `packages/types`) that excludes `baseMrr`/`byPlan` — only `mrr,momDelta,
payingTenants,unpricedActiveTenants,zeroPricedActiveTenants,activeWithoutSubscription` render. So
"the page shows baseMrr counting both…" isn't literally true today — refuter should confirm
whether that means the raw API response, a future UI, or a consumer this grep missed.

---

## Sibling map

- `cycle:` writers: `subscription-mutation.service.ts:209,326,336`(Stripe);
  `platform-admin.service.ts:774`(updatePlan, preserves prior). Upsert in
  `activateManualSubscription` never writes it (B863).
- `basePriceSnapshot` writers: `subscription-mutation.service.ts:329,339,726`(catalog);
  `billing-cron.service.ts:298`(downgrade); `billing.service.ts:528,831,844`(Stripe
  webhook/reconcile); `platform-admin.service.ts:1447`(override backfill, ungated — B864).
  `activateManualSubscription` reuses, never writes it.
- `TenantAddon.priceSnapshot` writers: `subscription-mutation.service.ts:367,369,1255,1257`
  (self-serve only). Admin `addon.service.ts:246-260` never writes it (B865).
- `emit` gated on `isPayingRow`: `platform-admin.service.ts:585,735,1019` (3 sites). Not gated:
  `:1456`(price override — B864), `:1981`(updateTenantClass, separate gap, `mrr.service.ts:76-
80`). Self-serve emits gate on SKU checks instead; cron emits are pre-scoped.
- Discount into a base figure: `mrr.service.ts:249` only; `:242` never subtracts it (B866).
  `priceSubscription()`(:299-310) subtracts it correctly into `rowPrice`/`mrr`.

## Lessons (confirm/drop)

- **L-167** (shared gate → ONE builder): CONFIRM, B864 — `isPayingRow` is that builder;
  override never adopted it.
- **L-152** ("one X" claim verified only one caller): CONFIRM, B865 — self-serve is "the" priced
  mechanism; admin grant is an unswept sibling, still money-blind.
- **L-119** (both halves of one money figure, ONE formula): CONFIRM, B866 — top-level and byPlan
  baseMrr are the two halves, two expressions, same loop.
- **L-170** (roundMoney wraps a sum before a comparison): weak fit, B866 (rounds once at :268 vs
  per-iteration at :249) — secondary, not primary.
- **L-159** (re-derived figures gate on ONE presence check): DROP — no bug fits that shape.
- **L-207** (never replay an incomplete ledger): DROP — B864 is two writers double-emitting, not
  a replay.
