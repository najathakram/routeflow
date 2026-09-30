# S2 refutation — F18 (B58 · B73 · B107)

Read-only pass against worktree `rf-watchdog` at **`597c72dc`** (master; `#636`/`#637`/`#638`
already merged). Every line citation below was opened on this tree in this pass. Anything I
did not open is marked **unverified**.

Method: for each bug I assumed the suspected cause is WRONG and tried to break the chain from
repro input to wrong output — a missing entry point, an intervening guard, a later commit that
already closed it, or a wrong-file/wrong-line claim. Where the chain held, I then attacked the
committed plan's FIX instead.

---

## B58 — "Change plan" always calls `subscribe()`

### Verdict: **confirmed**

The suspicion survives every attempt to break it. Attempts made and their outcomes:

1. _"Maybe some other UI already routes to upgrade/downgrade."_ — **Refuted.** Grep across
   `apps/web` + `apps/mobile` for `useUpgrade|useDowngrade|useProrationPreview|useSubscribe`
   returns only the definitions (`apps/web/lib/api/billing.ts:182,188,194,156`) plus the two
   `useSubscribe` references in `apps/web/app/(dashboard)/choose-plan/page.tsx:10,40`. Zero
   callers for `useUpgrade`/`useDowngrade`/`useProrationPreview` anywhere.
2. _"Maybe `subscribe()` already refuses an ACTIVE plan change somewhere between the read and
   the write."_ — **Refuted.** `subscribe()` runs plan lookup → `proration.quote` → prior-state
   reads (`:106-110`) → add-on reconcile → `$transaction` (`:149`). The only throws are
   `Unknown plan` / `Enterprise is custom` (`:97-99`), `Tenant not found` (`:111`) and the
   admin-only add-on `ForbiddenException` (`:132`). `tenant.status` is read at `:107` and used
   only at `:146-147` to decide `oldPlanMonthly`, never to gate.
3. _"Maybe the existing test suite already covers correct routing, so the gap is cosmetic."_ —
   **Refuted.** `find apps/web -name '*.test.ts(x)'` filtered on plan/billing returns nothing:
   there is **no** web unit test for `choose-plan/page.tsx` or `settings/billing/page.tsx`
   (this closes S1's open unknown #5). `apps/web/e2e/` has no plan-change spec.

**Diverging line on `597c72dc`:** `apps/api/src/billing/subscription-mutation.service.ts:168-173`
— the `upsert` **update** branch writes `periodStart: now` / `periodEnd` and clears
`cancelAtPeriodEnd: false, downgradeToPlanKey: null, downgradeEffectiveAt: null` for an
already-ACTIVE tenant. Reached because `apps/web/app/(dashboard)/choose-plan/page.tsx:66-67`
calls `subscribe.mutate({ planKey: selected, cycle })` unconditionally. The correct write for a
downgrade exists at `:330-331` (`downgradeToPlanKey: targetPlanKey`,
`downgradeEffectiveAt: sub.periodEnd`) inside `downgrade()` (`:311`), which no client reaches.

**New entry point the plan and S1 both missed (strengthens the case, does not change it):**
`/choose-plan` has **two** in-app entrances, not one —
`apps/web/app/(dashboard)/settings/billing/page.tsx:208` (`<a href="/choose-plan">` + "Change
plan") **and** `apps/web/app/(dashboard)/_components/gates/PlanGates.tsx:42`, the plan-gate
upsell card whose CTA reads `Upgrade to ${u.planKey}` (`PlanGates.tsx:28`). An ACTIVE payer who
hits a feature gate is the single most likely person to trigger this bug, and the button
literally says "Upgrade" while posting `/billing/subscribe`.

### Fix still valid? **amended** (six amendments; none is fatal)

**A1 — the E2E number and the F09 collision are settled, in F18's favour.** Use **33** (per
`corrections-F18.md` §1). On this tree `apps/web/e2e/` holds `…27, 28-credit-note-wallet,
30-recurring-standing, 31, 32, 34-calendar-dates` — **33 is free**, and F09's
`28-credit-note-wallet` **already landed**, with its project entry at
`apps/web/playwright.config.ts:503` (the last one). `corrections-F18.md` §4's three-surface
F09 collision is therefore **resolved, not pending**: append the `change-plan-routing` project
after `:503` and the code-map collision is likewise gone (`#637` landed F09's map follow-up).

**A2 — composing `planChangePreview` into `quote()` changes that endpoint's auth behaviour.**
`settings-billing.controller.ts:77-81` is `quote(@Body() dto: QuoteDto)` with **no**
`@CurrentUser()`; the class carries `@Roles(UserRole.OPERATOR)` (`:38`). A platform
SUPER_ADMIN satisfies OPERATOR via the role hierarchy but has `tenantId: null`, and
`tenantIdOf()` (`:52-57`) throws `ForbiddenException`. So
`{ ...quote, change: await mutations.planChangePreview(this.tenantIdOf(user), …) }` turns a
currently-200 SUPER_ADMIN quote into a 403. I found no such caller (grep for `billing/quote`
across `scripts/`, `apps/web/e2e/`, `apps/api/scripts/` returns nothing; the only caller
anywhere is `apps/web/lib/api/billing.ts:170`), so the blast radius is nil — but **amend the fix
to degrade instead of throw**: read `user.tenantId` directly and return `change: null` when it is
absent, so the pricing quote keeps working for a tenant-less caller. Web then treats
`change === null` as today's behaviour.

**A3 — the guard and the preview disagree on a same-rank plan rename, and that kills the only
re-pin path.** The plan's guard compares **raw** keys (`input.planKey !== priorSub.planKey`)
while `planChangePreview` compares **ranks**. `planRank` normalizes legacy keys
(`plan-catalog.constants.ts:84-88` — `TEAM→GROWTH`, `BUSINESS→SCALE`, `PROFESSIONAL→SCALE`;
`:92` `normalizePlanKey`; `:101-104` `planRank`). So a v7-pinned tenant on `planKey:"BUSINESS"`
choosing the v8 card `SCALE`: raw keys differ → **guard 409s**; ranks are equal → **preview says
NOOP** → the web disables the button. Today that exact click is the only way that tenant gets
re-pinned onto the current catalog, because `subscribe()` writes `planVersionId: version.id` on
both upsert branches (`:152`, `:165`) while `downgrade()` writes none. After the fix a
legacy-key tenant is stranded on a stale `planVersionId` with no self-service exit.
**Amend:** gate the `ConflictException` on
`planRank(input.planKey) !== planRank(priorSub.planKey)` (refuse only a genuine tier change),
and have `planChangePreview` return `SUBSCRIBE` — not `NOOP` — when ranks are equal but the raw
keys differ. Add a jest case: `sub.planKey "BUSINESS"` → `input "SCALE"`, same cycle → **must
not throw**, preview `SUBSCRIBE`. Keep the plan's `TEAM`→`SCALE` legacy case as well; it is
correct (`planRank("TEAM")=1 < planRank("SCALE")=2` → UPGRADE).

**A4 — the fixture mock ignores `select`, so widening `:108` is free but under-tested.**
`subscription-mutation.service.spec.ts` `make()` returns `opts.sub` verbatim from
`tenantSubscription.findUnique`, so changing `:108` to `select: { planKey: true, cycle: true }`
needs no mock change — but it also means **no test proves `cycle` is actually selected**. Add an
assertion on the `findUnique` call args, or the guard silently reads `undefined` in prod if
someone drops the field. (In prod `cycle` is non-nullable —
`apps/api/prisma/schema/platform.prisma:47` `cycle BillingCycle @default(MONTHLY)` — so
`undefined` only ever happens through a mock, which is exactly how spec `:130` passes today.)

**A5 — the dispatch drops add-ons if the page ever grows an add-on selector.** `subscribe()`
accepts `input.addons` and reconciles them (`:127-145`); `upgrade()` (`:262`) and `downgrade()`
(`:311`) take only a plan key. `choose-plan` sends no `addons` today (`page.tsx:67`), so nothing
is lost now — record it as a residual on the dispatch, not a blocker.

**A6 — bookkeeping numbers in the corrections are stale.** `.claude/lessons/_meta.json` on this
tree reads `nextId: 83`, `activeCount: 40`, `maxEntries: 40` — **zero headroom**; `L-045` is
already archived upstream and `L-082` is new. `corrections-F18.md` §2's "`nextId` is now 80" is
stale; §3's archive candidate **`L-056` is still active** (`LESSONS.md:254`) and still valid.

### Tests that pin the wrong behavior (must be rewritten)

- **`apps/api/src/billing/subscription-mutation.service.spec.ts:130`** —
  `it("re-subscribe to a LOWER plan emits a NEGATIVE plan delta and disables dropped add-ons")`,
  fixture `{ tenantStatus: "ACTIVE", sub: { planKey: "BUSINESS" } }` (`:132-133`, **no `cycle`
  field** — verified), calls `subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" })` (`:140`)
  and asserts it succeeds with `PLAN_CHANGED` delta `-290` (`:141`). This is the exact path the
  guard refuses. Re-scope to `sub: { planKey: "BUSINESS", cycle: "ANNUAL" }` + input `MONTHLY`
  and rename to a cycle-switch case, per the plan.
- **Nothing else in that file needs touching.** The only other ACTIVE fixture is `:341-347`
  (`sub: { planKey: "TEAM" }`, `subscribe(… planKey: "TEAM" …)`) — same plan key, so the guard
  short-circuits before it ever compares cycles. Stays green.

### Risks the plan missed

1. The SUPER_ADMIN 403 on `/billing/quote` (A2).
2. The equal-rank re-pin dead end (A3) — a silent, permanent capability loss for exactly the
   legacy-key tenants most likely to change plan.
3. `PlanGates.tsx:42` is a second entrance whose CTA already says "Upgrade" — the PR text and
   the T2 spec should name it; today it is the most user-visible face of the bug.
4. **There is no web unit test layer for this page at all** (verified). T2 spec 33 is therefore
   the _only_ proof of the web dispatch — if the project entry is missed, the web half ships
   with zero coverage, silently. Re-run spec 33 after appending to `playwright.config.ts:503`.
5. `retainedUserIds: []` from the web (already flagged in `corrections-F18.md` §7) means an
   over-cap tenant loses every non-admin OPERATOR/DRIVER at period end with no choice — a real
   consequence of the DOWNGRADE dispatch this batch introduces. **Unverified** here
   (`billing-cron.service.ts:168-190` not opened in this pass); do not ship the DOWNGRADE button
   without re-reading it.

---

## B73 — concurrent commission sync double-appends a CLAWBACK

### Verdict: **confirmed**, with a materially **narrower blast radius** than the plan states

Attempts to break the chain:

1. _"The accrual `update` at `:398` takes a row lock, so the second sync must serialize."_ —
   **True but insufficient.** T2's `commissionAccrual.update` does block on T1's row lock (the
   `unchanged` short-circuit at `:392-400` cannot fire, because `unchanged` requires
   `!newAdjustment` and T2 has one). After T1 commits, T2 proceeds and then executes
   `db.commissionAdjustment.create` at **`:417`** with the `newAdjustment` it computed from its
   **pre-block** snapshot. The second CLAWBACK still lands. The suspicion holds.
2. _"Maybe the database refuses the duplicate."_ — **Refuted.**
   `apps/api/prisma/schema/sales.prisma:1264-1283` — `CommissionAdjustment` carries only
   `@@index([agentId])` / `@@index([accrualId])` / `@@index([tenantId])` (`:1280-1282`). No
   `@@unique`. (The sibling `CommissionAccrual` does have one: `:1258`
   `@@unique([tenantId, invoiceId, agentId]) // the double-accrual lock`.)
3. _"Maybe `#623`'s `@LeaderCron` already fixed it."_ — **Partially.** This is the delta S1
   flagged and I confirm it:
   `apps/api/src/sales-agents/commission-reconciliation.service.ts:29` is now
   `@LeaderCron("30 * * * *", "commission-reconciliation.reconcileCommissions")`, and
   `apps/api/src/common/cron-lock.ts:6` documents the mechanism as a `pg_try_advisory_lock` on
   the job name — one replica runs the tick, the others return immediately. The cron's own loop
   (`:58`) is sequential. So **cron-vs-cron across replicas is dead**. What remains:
   **cron-vs-hook** and **hook-vs-hook** (two request threads touching the same invoice). The
   register's framing ("the hourly cron racing a payment-voided hook") is still live; the plan's
   "which is the pair the register names" sentence needs the cron-vs-cron half struck.

**Diverging line on `597c72dc`:** `apps/api/src/sales-agents/commission-engine.service.ts:417`
(`await db.commissionAdjustment.create({…})`, unconditional), fed by `:332-335`
(`priorAdjTotal` / `rawDrift`) computed off the unlocked read at `:185-200`
(`commissionAccruals: { include: { adjustments: true } }` at `:198`).

### Fix still valid? **amended** (the `FOR UPDATE` seam at the top of `runSync` is right)

**B1 — the call-site inventory in the plan is stale on every line and wrong on one file.**
Verified set on this tree (`syncInvoiceCommission(Safe)` grep):
`invoices.service.ts:1433, 1855, 3424, 3630, 3855, 4004, 4126, 4493, 4672, 4843, 4911, 4956,
5118, 5206, 5345, 5649` (16) · `bookkeeping.service.ts:227` · `customers.service.ts:1228` ·
`credit-notes.service.ts:465, 690` (**two**, not the four at `256/566/603/1059` the plan cites —
F09 `#636` rewrote that file) · plus `orders.service.ts:5592`, which calls
`commissionEngine.syncOrderInvoices(orderId, tx)`; the plan's direct
`orders.service.ts:5480` sync **does not exist** (`syncOrderInvoices` loops `runSync` via
`commission-engine.service.ts:99`). So: **20 direct sites + 1 indirect + the cron**, not 22. The
Serializable blocks are now `invoices.service.ts:3424` and `:3630`
(`{ isolationLevel: "Serializable" }` confirmed at the tx close after `:3424`). None of this
changes the fix — it is a one-seam change — but the PR text and the code-map entry must not
repeat the stale numbers.

**B2 — the lock is a NO-OP outside a transaction; make that a stated contract.**
`SELECT … FOR UPDATE` releases at statement end when `db` is not a transaction client. Today
every caller passes a `tx`, and `invoices.service.ts:5649` passes **no** `db` at all so the
engine opens its own `tenantTransaction` (`commission-engine.service.ts:60`) — safe. But the
signature is `runSync(invoiceId, db: any)` and nothing stops a future caller from passing
`this.prisma.forTenant()`, which would silently restore the bug. **Amend:** state the contract in
the `runSync` docblock ("`db` MUST be a transaction client — the lock is meaningless otherwise")
alongside the class-docblock update the plan already asks for.

**B3 — `tenantId` must be threaded or re-read, and the raw predicate has a NULL hole.**
`runSync` has no `tenantId` in scope; it is read at `:53` (`syncInvoiceCommission`), `:89`
(`syncOrderInvoices`) and `:144` (`recomputeCommissionRange`), each of which returns early when
it is null. Re-reading `this.prisma.getTenantId()` inside `runSync` is the smaller diff and is
already exercised by the spec path. **But**: `CommissionAccrual.tenantId` is `String?`
(`sales.prisma:1249`), so `WHERE "invoiceId" = $1 AND "tenantId" = $2 FOR UPDATE` matches
**zero rows** for a legacy NULL-tenant accrual — the lock silently no-ops there, and the
`@@unique([tenantId, invoiceId, agentId])` backstop at `:1258` is _also_ void for those rows
(Postgres treats NULLs as distinct). New rows always get a `tenantId` injected by the write
proxy (`prisma.service.ts` `WRITE_METHODS`), so this is a legacy-data hole, not a new one.
**Record as a residual**, do not widen the PR (L-008).

**B4 — say out loud that the lock does not cover the create path.** On a first sync no
`CommissionAccrual` row exists, so `FOR UPDATE` locks nothing and provides no serialization —
which is fine, because the create path is backstopped by `:1258`'s unique key and re-checked at
`commission-engine.service.ts:477-481`. Without a sentence in the docblock a reviewer will read
the lock as covering both paths.

**B5 — a sibling the plan did not enumerate:** `orders.service.ts:5551` calls
`removeInvoiceCommission(inv.id, tx)` (`commission-engine.service.ts:110`), which `findMany`s
the accruals and `deleteMany`s them plus their unclaimed adjustments **without** the new lock. A
concurrent `runSync` holding the accrual `FOR UPDATE` and a `removeInvoiceCommission` deleting
the same rows can interleave. No lock inversion (both stay inside Invoice→CommissionAccrual), so
no new deadlock class — but the removal path arguably wants the same seam. **Record, don't fix.**

**B6 — mechanics the plan asserted, verified true.** `db.$executeRaw` reaches every `db` shape:
the tenant tx proxy returns `$`-prefixed members bound and untouched
(`prisma.service.ts:108-124` — `modelName.startsWith("$")` → `model.bind(target)`), and
`tenantTransaction` itself already issues `rawTx.$executeRaw` for the RLS `set_config`
(`:53-57`). The `sales-agents.service.spec.ts` tx fake already provides `$executeRaw` (`:50-52`),
so the blast radius of the spec groundwork really is the one engine spec file.

### Tests that pin the wrong behavior

**None.** No existing test asserts the double-append. The failure mode is a _hole_, not a pinned
assertion:

- `apps/api/src/sales-agents/commission-engine.service.spec.ts` — `grep executeRaw` returns
  **nothing**; `buildFakeDb` starts at `:19`. Adding the lock without the
  `$executeRaw: jest.fn()` groundwork turns **every** test in the file red with
  `db.$executeRaw is not a function`. This is groundwork, not a rewrite.
- The drift test (`"a negative drift emits exactly one CLAWBACK adjustment…"`, ~`:353-397`) runs
  two **sequential** syncs against the same fake and must stay unchanged — it pins single-sync
  idempotency, not the race.
- The flag-OFF test (~`:126`) asserts `db.invoice.findUnique` is never called; the early returns
  at `:53-55` must stay **before** the new lock. Add the `$executeRaw`-not-called assertion the
  plan asks for.

### Risks the plan missed

1. `@LeaderCron` (`#623`) already removed the cron-vs-cron replica race — the fix is still
   needed for cron-vs-hook and hook-vs-hook, but the PR must not claim to close a race that
   `1ebd4f54` closed a day earlier.
2. The non-transactional-`db` no-op (B2) and the NULL-`tenantId` lock/unique hole (B3).
3. `removeInvoiceCommission` takes no equivalent lock (B5).
4. All 20 call-site line numbers in the plan are stale after `#636`; a reviewer checking them
   will find the wrong code and may reject a correct fix.

---

## B107 — `disableAddon` nulls `stripeItemId` even when the Stripe delete failed

### Verdict: **confirmed**

Attempts to break the chain:

1. _"Maybe the catch rethrows in some branch."_ — **Refuted.**
   `apps/api/src/billing/addon.service.ts:184-188` is
   `catch (err) { this.logger.error(…) }` with no `throw`; control falls straight into
   `:191-194` `tenantAddon.update({ data: { active: false, stripeItemId: null } })`.
2. _"Maybe the controller detects the failure."_ — **Refuted.**
   `platform-admin.controller.ts:329` awaits the service and then unconditionally writes
   `recordAdminAction(… ADDON_ENABLED …)` (`:330-332`); `:344-347` mirrors it for disable. The
   service is the only place that can refuse — and the plan's claim that `recordAdminAction`
   correctly runs only _after_ a successful call is **confirmed** (a throw skips the audit row).
3. _"Maybe the buggy method is dead code superseded by the self-service twin."_ — **Refuted, and
   the blast radius is exactly one caller each.** `AddonService.enableAddon`/`disableAddon` have
   precisely one production caller apiece (`platform-admin.controller.ts:329` / `:344`); the
   tenant self-service surface goes to `SubscriptionMutationService.enableAddon`/`disableAddon`
   (`settings-billing.controller.ts:152` / `:160`), a different pair. So this is a
   platform-admin-only fix — good for risk, and it means no tenant-facing flow changes at all.

**Diverging lines on `597c72dc`:** `addon.service.ts:184-188` (log-only catch) → `:191-194`
(unconditional `{ active: false, stripeItemId: null }`). Mirror on enable: `:133-138` (catch
with the comment `// Continue — don't block add-on activation over Stripe failure` at `:137`) →
`:143` `tenantAddon.upsert` with `active: true`. Third path (the L-029 sibling): `:122`
`if (sub?.stripeSubId)` — a supplied `stripePriceId` with no Stripe subscription skips the whole
block silently and activates unbilled.

**Precision correction to the plan's root cause (it is right, but state it exactly):** the
enable `upsert`'s **update** branch writes `stripeItemId: stripeItemId ?? undefined` (`:152`), so
a failed `create` on a _re-enable_ preserves whatever id was there — except that `disableAddon`
already nulled it (`:193`), so in the realistic re-enable path it is null anyway. The **create**
branch writes `stripeItemId` (null) directly. Both end at "active, unbilled".

**Resolves S1's open unknown #1:** `TenantAddon.stripeItemId` lives at
`apps/api/prisma/schema/platform.prisma:89` (model at `:78-99`).

### Fix still valid? **amended** (two mechanical amendments)

**C1 — `make()` does not expose the Stripe mock.** `addon.service.spec.ts:13` `make()` builds
`const stripe = { isConfigured: false, client: {} }` (`:23`) and returns
`{ svc, prisma, entitlements, catalog }` (`:29`) — **`stripe` is not returned**. The plan says
"extend `make()` with `stripe?: any`"; it must **also return it**, or the tests cannot assert
`del`/`create` call counts. Also: `tenantSubscription.findUnique` already resolves `null`
(`:21`), so the plan's case (4) (`stripeSubId: null` → `ConflictException`) works with the
default fixture; only case (3) needs an override to `{ stripeSubId: "sub_1" }`.

**C2 — the existing disable test stays green, for the reason the plan gives.**
`addon.service.spec.ts:68-88` `it("invalidates entitlements after disabling")` uses
`existingAddon: { id: "addon1", addonKey: "msrp", active: true }` — **no `stripeItemId`** — and
`isConfigured: false`, so `:178`'s guard is false on both counts and the Stripe branch is never
entered. (The plan cited it as lines 70-80; actual `68-88`.)

Everything else in the plan's fix holds on this tree: `resource_missing`-as-success, no
migration, no new column, controller and web untouched.

### Tests that pin the wrong behavior

**None.** No test in `addon.service.spec.ts` reaches either failure path — `stripe.isConfigured`
is hardcoded `false` at `:23` for every case. The gap is total absence of Stripe-failure
coverage, so the REG tests are additive; nothing needs rewriting beyond the `make()` signature
(C1).

### Risks the plan missed

1. **Whether any operational script drives the platform-admin add-on endpoints over HTTP is
   unverified** — I grepped only `apps/api/src` for service callers. If a seed/ops script POSTs
   `/platform-admin/tenants/:id/addons/enable` with a `stripePriceId` against a tenant that has
   no `stripeSubId`, the new `ConflictException` (the L-029 sibling) turns a previously-silent
   success into a hard failure. Cheap to check before shipping; **unverified here.**
2. The plan's own note is right and worth restating as a hard boundary: the twins in
   `subscription-mutation.service.ts:433` (`disableAddon`, never reads `stripeItemId`) and
   `billing-cron`'s `applyScheduledCancellations` deactivate rows without touching Stripe. With
   `AddonService` now refusing and the twins still silent, the codebase carries **two opposite
   contracts for the same invariant**. Record the follow-up B-row explicitly in the PR so the
   inconsistency is deliberate, not accidental.

---

## Overall verdict

All three suspicions survive refutation on `597c72dc`: B58's `subscribe()` writes
`periodStart: now` and clears the downgrade fields at `subscription-mutation.service.ts:168-173`
with no ACTIVE guard, reached unconditionally from `choose-plan/page.tsx:66-67` (and from a
second, "Upgrade"-labelled entrance at `PlanGates.tsx:42` that neither the plan nor S1 names);
B73's unconditional `commissionAdjustment.create` at `commission-engine.service.ts:417` is fed
by an unlocked snapshot and backed by a table with no `@@unique` (`sales.prisma:1280-1282`);
B107's log-only catches at `addon.service.ts:184-188` and `:133-138` fall through to writes that
destroy the only pointer to a still-billing Stripe item. Each committed fix is **directionally
right and stays valid**, with amendments: B58 needs the guard gated on `planRank` equality rather
than raw-key inequality (or a legacy-key tenant loses its only catalog re-pin path) and needs
`quote()` to degrade to `change: null` rather than 403 a tenant-less caller; B73 needs its stale
call-site inventory replaced (20 direct sites + 1 indirect + cron, all moved by `#636`), its
`#623` `@LeaderCron` overlap acknowledged (cron-vs-cron is already dead; cron-vs-hook and
hook-vs-hook are the live exposure), and three residuals recorded (a non-transactional `db`
no-ops the lock; NULL-`tenantId` accruals escape both the lock and the unique key;
`removeInvoiceCommission` takes no equivalent lock); B107 needs only `make()` to return its
Stripe mock. The one piece of genuinely good news is that `corrections-F18.md` §4's three-way
F09 collision has **resolved itself** — `#636`/`#637` landed, spec 28 and its project entry
exist, spec 33 is free, and the code-map follow-up is already merged — so F18 appends cleanly.
Bookkeeping is worse than the corrections say: lessons sit at 40/40 with `nextId: 83`, so an
archive (`L-056`, still active at `LESSONS.md:254`) is mandatory before F18's close-out entry.

## Exact wrong values per REG test

**`REG-B58` (jest, `subscription-mutation.service.spec.ts`)** — fixture
`{ tenantStatus: "ACTIVE", sub: { planKey: "BUSINESS", cycle: "MONTHLY", periodStart, periodEnd } }`,
call `subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" })`:

- wrong: the call **resolves**; `tx.tenantSubscription.upsert` is called with
  `data.periodStart === now` (today) and `data.downgradeToPlanKey === null`,
  `data.downgradeEffectiveAt === null`, `data.cancelAtPeriodEnd === false`; a `PLAN_CHANGED`
  event is emitted with `amountDelta -290`.
- right: **rejects `ConflictException`**; `upsert` never called; `events.emit` never called;
  `periodStart` unchanged.
- `planChangePreview("t1","STARTER","MONTHLY")` on that fixture — wrong today: the method does
  not exist. Right: `{ action: "DOWNGRADE", proratedNow: null, effectiveAt: <periodEnd ISO> }`.
- equal-rank case (A3), `sub.planKey "BUSINESS"` → `input "SCALE"`, same cycle: must **not**
  throw and must preview `SUBSCRIBE` (not `NOOP`), or the legacy re-pin path dies.

**`REG-B58` (Playwright spec 33, interception-only)** — with `/billing/quote` fulfilled as
`change: { action: "UPGRADE", proratedNow: 123.45 }`:

- wrong: `POST /billing/subscribe` hits **1**, `POST /billing/subscription` hits **0**, button
  reads `Subscribe to <plan>`, "Due today" shows the **full cycle price**.
- right: subscribe hits **0**, upgrade hits **1**, button `Upgrade to <plan>`, Due today
  `$123.45`.
- DOWNGRADE variant — wrong: subscribe **1**, downgrade **0**. Right: downgrade **1**,
  subscribe **0**, button `Schedule downgrade to <plan>`, Due today `$0`.

**`REG-B73` (jest, `commission-engine.service.spec.ts`)** — one accrual at `claimedAmount 100`,
`payableAmount 60` (drift `-40`), a concurrent sync having committed its own `-40` CLAWBACK
while this one waited:

- wrong: `calls.adjustments.length === 1` with `amount -40` appended on top of the other's — the
  accrual's adjustments sum to **`-80`** instead of `-40`; `db.$executeRaw` never invoked.
- right: `calls.adjustments.length === 0` (sum stays `-40`), and
  `$executeRaw.mock.invocationCallOrder[0] < invoice.findUnique.mock.invocationCallOrder[0]`,
  with the joined template containing `FROM "CommissionAccrual"`, `"invoiceId" =` and
  `FOR UPDATE`, and `"inv-1"` among the bound values.
- flag-OFF case — right: `$executeRaw` **not called** and `invoice.findUnique` **not called**.

**`REG-B107` (jest, `addon.service.spec.ts`)** — `existingAddon { stripeItemId: "si_1", active: true }`,
`stripe.isConfigured true`, `subscriptionItems.del` rejecting `{ code: "api_error", statusCode: 500 }`:

- wrong: the call **resolves 200**; `tenantAddon.update` called with
  `{ active: false, stripeItemId: null }`; `entitlements.invalidate` called — Stripe still bills
  `si_1` and the only pointer to it is gone.
- right: **rejects `ServiceUnavailableException`**; `tenantAddon.update` **not** called;
  `invalidate` **not** called; `stripeItemId` still `"si_1"`.
- `resource_missing` / 404 variant — right: **resolves**, `update` called with
  `{ active: false, stripeItemId: null }` (the retry path; a fix that over-refuses turns this
  red).
- enable with `price_1`, `stripeSubId "sub_1"`, `subscriptionItems.create` rejecting — wrong:
  `tenantAddon.upsert` called with `active: true, stripeItemId: null` (paid add-on granted free).
  Right: rejects `ServiceUnavailableException`, `upsert` **not** called.
- enable with `price_1` and `stripeSubId: null` — wrong: resolves, `upsert` called with
  `active: true, stripeItemId: null`. Right: rejects `ConflictException`, `upsert` not called.
- enable with **no** `stripePriceId` while Stripe is configured — must still **resolve** and
  `upsert` (pins the admin-granted free-add-on path against over-refusal).
