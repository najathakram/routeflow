# Cause brief — B58, B73, B107 F18 billing plan-change / commission / add-on seam

## The bug as stated

### B58 — "Change plan" always calls subscribe

**Source (B58.md, quoted verbatim).** "**Actually does.** The only change-plan UI path calls
useSubscribe -> POST /billing/subscribe unconditionally for every plan change. subscribe()
always sets periodStart=now and periodEnd=addCycle(now) and charges the full new-plan quote.
useUpgrade/useDowngrade/useProrationPreview exist, are fully typed, and have zero callers
anywhere in apps/web."

**Repro.** Input: an ACTIVE tenant on plan BUSINESS (mid-cycle) clicks "Change plan" →
choose-plan → picks STARTER (a lower plan) → commit(). Observed: `commit()`
(`choose-plan/page.tsx:64-76`) calls `subscribe.mutate({ planKey: selected, cycle })`
unconditionally; the server's `subscribe()` (`subscription-mutation.service.ts:94-259`)
writes `periodStart: now` / `periodEnd: addCycle(now)` on both upsert branches
(lines 158-159, 168-169) and clears `cancelAtPeriodEnd`/`downgradeToPlanKey`/
`downgradeEffectiveAt` (171-173) — the downgrade takes effect **instantly** and the
metering period resets to today. Expected: a downgrade should be scheduled at
`sub.periodEnd` (the `downgrade()` method, lines 311-344, already implements this
correctly and is simply never called by the web). The exact wrong value: after commit(),
`tenantSubscription.periodStart` = `now` (today's date) instead of remaining the prior
`periodStart`; `tenantSubscription.downgradeToPlanKey` stays `null` instead of being set
to the target plan.

**Suspected cause (claim, quoting F18.md).** "Two facts compose. (1) …choose-plan/page.tsx
is a single-purpose 'commit a subscription' screen: it never calls useSubscription, its
commit() (lines 64-76) posts /billing/subscribe unconditionally via useSubscribe
(lib/api/billing.ts:182-186) … useUpgrade/useDowngrade (billing.ts:188-198) have zero
callers … (2) Server-side, subscribe() (subscription-mutation.service.ts:94-259) …
has NO guard for an already-ACTIVE planKey-holder: it unconditionally writes
periodStart=now/periodEnd=addCycle(now) on both upsert branches (158-159, 168-169),
clears cancelAtPeriodEnd/downgradeToPlanKey (171-173)." Evidence for the claim is the
line-cited source itself, verified below to match this tree exactly.

### B73 — Concurrent commission sync double-appends a CLAWBACK

**Source (B73.md, quoted verbatim).** "**Actually does.** Drift is computed from a plain
non-locking read of existing.adjustments, then commissionAdjustment.create runs
unconditionally — no unique constraint, no pre-insert re-check, no row lock. The accrual
path a few lines away has exactly that pre-insert re-check; the adjustment path does not."

**Repro.** Input: an invoice with `commissionAccruals[0]` at `claimed=100, payable=60`
(a negative drift of -40 relative to zero prior adjustments), synced twice concurrently
(e.g. the hourly reconciliation cron racing a payment-voided hook), both under READ
COMMITTED. Observed: each `runSync` call reads the invoice with a plain
`db.invoice.findUnique` (line 185, no lock) including `commissionAccruals.adjustments`
(line 198); each computes `priorAdjTotal` from that same pre-commit snapshot (line 332),
each computes the same `rawDrift = -40` (line 335), and each unconditionally
`commissionAdjustment.create`s (line 417) — the agent is clawed back **twice**
(`-40` then another `-40` = `-80` total). Expected: exactly one `-40` CLAWBACK row for
the one true drift event; ledger invariant `drift(A) = payable(A) − claimedAmount(A) −
Σadjustments(A)` should converge to ~0 after one adjustment. The exact wrong value:
`CommissionAdjustment` rows for the accrual sum to `-80` instead of `-40` (double the
correct deduction).

**Suspected cause (claim, quoting F18.md).** "commission-engine.service.ts runSync
(184-309) reads the invoice with a plain include of commissionAccruals.adjustments
(185-200) and no lock; syncAccrualRow computes priorAdjTotal from that snapshot
(332-335), decides drift (343-357) and inserts the CommissionAdjustment unconditionally
(416-426). CommissionAdjustment has only @@index, no @@unique … so a duplicate cannot
fail at the database." The plan further corrects the register's implied symmetry: "the
create path's pre-insert re-check (477-481) does NOT by itself prevent a double insert
under READ COMMITTED … that path is actually saved by the @@unique([tenantId,
invoiceId, agentId]) backstop … Copying the re-check to the adjustment path would
therefore NOT fix B73; a lock … is required."

### B107 — disableAddon nulls stripeItemId even when the Stripe delete failed

**Source (B107.md, quoted verbatim).** "**Actually does.** subscriptionItems.del is
wrapped in a log-only catch, then the update unconditionally writes active:false,
stripeItemId:null and returns 200. Enable has the mirror flaw: a failed create still
activates with stripeItemId null."

**Repro.** Input: a platform admin disables an add-on whose `TenantAddon.stripeItemId`
= `'si_123'` while Stripe returns a 500 (transient API error) on
`subscriptionItems.del('si_123')`. Observed: the `catch` block (`addon.service.ts:184-189`)
only logs the error; execution falls through to the unconditional
`tenantAddon.update({ data: { active: false, stripeItemId: null } })` (lines 191-194),
which returns 200 to the caller. Expected: the operation should fail loudly (the
tenant is still being billed for the Stripe item) and `stripeItemId` should be preserved
so the delete can be retried. The exact wrong value: after the call, `TenantAddon.active`
= `false` and `TenantAddon.stripeItemId` = `null`, while the live Stripe subscription
still carries the item `si_123` — the only stored pointer to it is destroyed and the row
looks "clean" (add-on off, no dangling id) even though Stripe is still charging for it.
The mirror on enable: a failed `subscriptionItems.create` (caught at
`addon.service.ts:133-138` with the comment "Continue — don't block add-on activation
over Stripe failure") still results in `tenantAddon.upsert` activating the row
(`active: true`) with `stripeItemId: null` — a paid add-on granted free.

**Suspected cause (claim, quoting F18.md).** "addon.service.ts treats Stripe as
best-effort telemetry rather than the money half of a two-part state change.
disableAddon (168-199): the subscriptionItems.del is wrapped in a log-only catch
(179-189) and then the update at 191-194 unconditionally writes { active: false,
stripeItemId: null } and returns 200 … enableAddon (79-162) has the mirror … L-029
sibling in the SAME method, not in the register: line 122 `if (sub?.stripeSubId)` —
when the admin supplies a stripePriceId … but the tenant has no Stripe subscription,
the whole Stripe block is skipped silently and the add-on activates unbilled."

## Code path

### B58

Entry point: `apps/web/app/(dashboard)/choose-plan/page.tsx` — the ONLY UI destination
for "Change plan" (`settings/billing/page.tsx:208-209`, a plain `<a href="/choose-plan">`

- `<Button>Change plan</Button>`, verified unchanged on this tree).

1. `commit()` (`choose-plan/page.tsx:64-76`):
   ```
   64:  const commit = () => {
   66:    subscribe.mutate(
   70:          toast({ title: "Subscribed", description: `You're now on the ${selected} plan.` });
   ```
   `subscribe` comes from `useSubscribe()` (`lib/api/billing.ts:182-186`, confirmed:
   `apiClient.post("/billing/subscribe", body)`), called unconditionally regardless of
   whether the tenant already has an ACTIVE subscription on a different plan.
2. Server: `SettingsBillingController.subscribe()` (`settings-billing.controller.ts`,
   `@Post("subscribe")`, `@Roles(TENANT_ADMIN)`) → `mutations.subscribe(tenantId, dto, user.sub)`.
3. `SubscriptionMutationService.subscribe()` (`subscription-mutation.service.ts:94-259`):
   reads prior state at 106-110 —
   ```
   106:    const [tenant, priorSub, priorAddons] = await Promise.all([
   107:      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
   108:      this.prisma.tenantSubscription.findUnique({ where: { tenantId }, select: { planKey: true } }),
   109:      this.prisma.tenantAddon.findMany({ where: { tenantId, active: true } }),
   110:    ]);
   ```
   — no branch anywhere checks `tenant.status === "ACTIVE" && priorSub?.planKey` against
   `input.planKey`/`input.cycle` before proceeding. Diverging write, inside the
   `$transaction` (149-254):
   ```
   150:      await tx.tenantSubscription.upsert({
   ...
   158:           periodStart: now,
   159:           periodEnd,
   ...
   168:           periodStart: now,
   169:           periodEnd,
   170:           basePriceSnapshot: def.monthlyPrice,
   171:           cancelAtPeriodEnd: false,
   172:           downgradeToPlanKey: null,
   173:           downgradeEffectiveAt: null,
   ```
   This is the diverging behavior: `downgrade()` (311-344) exists and does the right
   thing (`downgradeToPlanKey`, `downgradeEffectiveAt: sub.periodEnd`, no period write,
   `amountDelta: 0`) but is reached from nowhere in `apps/web` — confirmed by grep:
   `useUpgrade`/`useDowngrade` are defined (`billing.ts:188-198`) with zero call sites
   outside their own definitions.
4. `/billing/quote` (`settings-billing.controller.ts`, `@Post("quote")` →
   `this.proration.quote(dto)`) returns a `QuoteResult` (`billing.ts:78-86`) with no
   `change`/action field at all — the web has no server signal to route on even if it
   wanted to.

### B73

Entry point: any of the ~22 hook call sites (invoices/credit-notes/bookkeeping/customers/
orders services) or the `:30`-past-the-hour cron (`commission-reconciliation.service.ts`,
now `@LeaderCron("30 * * * *", ...)` — see History) calling
`syncInvoiceCommission(invoiceId)` → `runSync(invoiceId, db)`.

```
184:  private async runSync(invoiceId: string, db: any): Promise<void> {
185:    const invoice = await db.invoice.findUnique({
186:      where: { id: invoiceId },
187:      include: {
188:        payments: { select: { id: true, amount: true, method: true, status: true } },
...
198:        commissionAccruals: { include: { adjustments: true } },
199:      },
200:    });
```

No `SELECT … FOR UPDATE` or any lock precedes this read. Further down:

```
332:    const priorAdjTotal = roundMoney(
...
335:    const rawDrift = roundMoney(targetPayable - claimedAmount - priorAdjTotal);
```

computed purely from the `invoice.commissionAccruals[].adjustments` array captured at
line 185's snapshot. Diverging write:

```
417:      await db.commissionAdjustment.create({
```

— unconditional, no re-check against a concurrently-committed adjustment. Contrast the
sibling accrual-creation path's guard:

```
470:    // Re-check the double-accrual lock (@@unique([tenantId, invoiceId, agentId]))
...
477:    const alreadyAccrued = await db.commissionAccrual.findFirst({
...
481:    if (alreadyAccrued) return;
```

— `commissionAdjustment` has no equivalent re-check and no `@@unique` to fall back on
(see schema excerpt below).

### B107

Entry point: `PlatformAdminController` → `AddonService.disableAddon(tenantId, addonKey)`
(`addon.service.ts:168-199`):

```
168:  async disableAddon(tenantId: string, addonKey: string) {
169:    const addon = await this.prisma.tenantAddon.findUnique({...});
...
178:    if (addon.stripeItemId && this.stripe.isConfigured) {
179:      try {
180:        await this.stripe.client.subscriptionItems.del(addon.stripeItemId);
...
184:      } catch (err) {
185:        this.logger.error(
186:          `Failed to remove Stripe item ${addon.stripeItemId}: ${(err as Error).message}`,
187:        );
188:      }
189:    }
190:
191:    const updated = await this.prisma.tenantAddon.update({
192:      where: { tenantId_addonKey: { tenantId, addonKey } },
193:      data: { active: false, stripeItemId: null },
194:    });
```

The `catch` at 184-188 has no `throw` — control falls through unconditionally to the
`update` at 191-194 regardless of whether `del` succeeded. Mirror on enable
(`addon.service.ts:79-162`):

```
122:      if (sub?.stripeSubId) {
123:        try {
124:          const item = await this.stripe.client.subscriptionItems.create({...});
...
133:        } catch (err) {
134:          this.logger.error(
...
137:          // Continue — don't block add-on activation over Stripe failure
138:        }
139:      }
143:    const addon = await this.prisma.tenantAddon.upsert({
...
```

`upsert` at 143 runs unconditionally after the swallowed catch, with `stripeItemId`
(the `item.id` variable, still `null` from its line-115-ish declaration) written as-is.

## History

```
=== subscription-mutation.service.ts ===
22372911 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
b1a0e099 fix(billing): addon catalog validation, cache invalidation, self-service gate (#433)
11df7fa2 feat(billing): publish catalog v8 — Starter/Growth/Scale at $99/$249/$499 (#396)
10dd718b feat(billing): server-side MRR rollup + churn-aware ledger (Plans & Billing P6) (#147)
27d05ac7 feat(billing): subscribe/upgrade/downgrade + add-on toggle mutations + billing UI (#141)

=== choose-plan/page.tsx, apps/web/lib/api/billing.ts ===
27d05ac7 feat(billing): subscribe/upgrade/downgrade + add-on toggle mutations + billing UI (#141)
(no changes since — the orphaned useUpgrade/useDowngrade hooks and the unconditional
commit()->subscribe wiring both date to the original #141 implementation)

=== commission-engine.service.ts ===
22372911 refactor(pricing,api,ci): @routeflow/pricing package + wave B′ API hardening (#613)
ea8a7479 fix(api): tenant-scope findUnique sweep — cross-tenant read isolation (#446)
a084d317 feat(commissions): exclude NSF bounce fees from the commission base (#428)
e460b3f8 feat(sales-agents): agent records, commission ledger, statements engine (#421)
```

`git blame` on `runSync`'s invoice-read block (184-200) attributes it entirely to
`e460b3f8` (2026-08-23, the original engine implementation, #421) except line 189
(`items: {...}`, added by `a084d317`/#428, unrelated to the race). The implicated
period-write lines in `subscribe()` (150-176) all trace to the original `27d05ac7`
(2026-07-08, #141) except `currentPlan: planKeyToEnum(...)` on 156/166, added by
`11df7fa2` (#396, catalog v8). Neither file's history shows any later attempt to guard
the seam — #613's "API hardening" pass touched the file (likely the `@routeflow/pricing`
import swap) but not this logic.

```
=== addon.service.ts ===
b1a0e099 fix(billing): addon catalog validation, cache invalidation, self-service gate (#433)
da5e89fa Fix remaining TypeScript errors and ship all pending features
```

`disableAddon` (168-199) is entirely `git blame`-attributed to `da5e89fa` (2026-04-08,
the original implementation) except line 196 (`entitlements.invalidate`, added by
`b1a0e099`/#433). The log-only catch has never been touched since April.

```
=== commission-reconciliation.service.ts ===
1ebd4f54 feat(api): 2b — leader-elected crons via advisory locks, per-family lock pools (#623)
e460b3f8 feat(sales-agents): agent records, commission ledger, statements engine (#421)
```

`#623` (2026-09-05/06) converted the cron from a bare `@Cron("30 * * * *", ...)` to
`@LeaderCron("30 * * * *", "commission-reconciliation.reconcileCommissions")` — see
Open unknowns below; this postdates both the plan (`e5b0af8e`, 2026-08-29) and its
staleness-correction pass and is not mentioned in either.

```
=== apps/api/prisma/schema/sales.prisma (holds CommissionAccrual/CommissionAdjustment) ===
60d10e66 fix(types,api,mobile,web): wave E — shared enums/DTOs (10b) + schema folder split (10a) (#621)
```

The single-file `schema.prisma` the plan cites line numbers against (`4289-4308`,
`4343-4348`) no longer exists — `#621` (2026-09-04/05) split it into
`apps/api/prisma/schema/{_base,tenancy,catalog,sales,finance,platform,compliance}.prisma`.
The models moved to `sales.prisma` with new line numbers (see Open unknowns).

## Existing tests around this behavior

### B58

`subscription-mutation.service.spec.ts`:

- Line 130: `it("re-subscribe to a LOWER plan emits a NEGATIVE plan delta and disables
dropped add-ons", ...)` — fixture `make({ tenantStatus: "ACTIVE", sub: { planKey:
"BUSINESS" } })` (confirmed: **no `cycle` field** on the fixture's `sub`), calls
  `svc.subscribe("t1", { planKey: "STARTER", cycle: "MONTHLY" }, "admin")` and asserts
  it **succeeds** — `PLAN_CHANGED` delta = `-290`, `ADDON_DISABLED` delta = `-12`, the
  addon's `active: false`. **This test pins the wrong behavior**: an ACTIVE tenant
  moving to a lower plan via `subscribe()` is asserted to succeed and to reset the
  period, which is exactly the bug. It only reaches this path "by accident" per the
  plan's own analysis, since the fixture's `sub` has no `cycle`, so a guard comparing
  `input.cycle === priorSub.cycle` would currently treat it as a cycle-mismatch
  (`undefined !== "MONTHLY"`) rather than a same-cycle downgrade — confirmed: `make()`'s
  `sub` fixture shape only sets `planKey` here, nothing else.
- No test anywhere asserts `subscribe()` REJECTS a same-cycle ACTIVE plan change, and
  no test exists for a `planChangePreview`-shaped function (it does not exist on this
  tree — `grep planChangePreview` returns nothing outside the plan/correction docs).
- `choose-plan/page.tsx` has no `.test.tsx` file found in this walk (not opened —
  scope was source, not test enumeration for web; note as open unknown if S2 needs it).

### B73

`commission-engine.service.spec.ts`:

- `buildFakeDb` (lines 19-78) confirmed to have **no `$executeRaw`** on its `db` object
  — any lock statement added to `runSync` before the invoice read will throw
  `db.$executeRaw is not a function` for every test in this file that doesn't add it.
- "drift emission" describe (352-397): `"a negative drift emits exactly one CLAWBACK
adjustment, and re-running with the converged state emits none"` (353) — asserts
  single-sync idempotency (a second sync AFTER the first commits sees the adjustment
  and emits nothing more). **This does not pin or exercise the concurrent race** — it
  runs two sequential syncs against the SAME fake db instance, which already reflects
  the first sync's write by the time the second starts; it does not model two `runSync`
  calls both reading a stale snapshot before either commits. This test does not pin the
  wrong behavior; it simply doesn't reach the race at all.
- "flag / tenant gating" (125-146): "flag OFF writes nothing and never touches the
  database" (126) asserts `db.invoice.findUnique` is never called when the flag is off
  — this is the assertion the plan says must stay true after a lock is added before
  the read (i.e., the early return at line 55 must stay before any new lock call).

### B107

`addon.service.spec.ts`:

- `make()` (line 13) hardcodes `stripe = { isConfigured: false, client: {} }` (line 23)
  — confirmed no test in this file exercises the Stripe-configured branch on either
  `enableAddon` or `disableAddon` at all. The existing "invalidates entitlements after
  disabling" test (referenced by the plan at 70-80) runs with `isConfigured: false`, so
  Stripe's `del`/`create` are never called and the log-only catch is never reached.
  **No existing test pins the wrong behavior directly** — the gap is total absence of
  Stripe-failure coverage, not a passing assertion of the bad outcome.

## Production evidence (if any)

None found in the inputs reviewed — B58/B73/B107 registry records all list `proof:`
(empty) in front-matter and `state: queued`; the F18 ledger shard
(`.claude/campaign/status/F18.jsonl`) shows all three rows with `"pr":null,
"proof":null,"evidence":null`. B107's verifier note explicitly states the failure
"requires a Stripe API failure coincident with the disable call" (a narrow trigger
window) and that recovery is manual but possible via `AdminAudit` + Stripe's item list
— no dollar amounts or tenant ids are cited anywhere in the reviewed inputs. Money
amounts in the "Repro" sections above ($-40, $-80, -290, etc.) are all synthetic
fixture/spec values, not production data.

## Open unknowns

1. **Schema line numbers are stale on this tree for B73/B107.** The plan and both
   registry records cite `apps/api/prisma/schema.prisma` (a single file) at
   `4289-4308`/`4343-4348` (CommissionAccrual/CommissionAdjustment) and `562`
   (TenantAddon.stripeItemId). That file no longer exists — `#621` (`60d10e66`) split
   it into `apps/api/prisma/schema/*.prisma`. New locations on this tree:
   - `CommissionAccrual` model: `apps/api/prisma/schema/sales.prisma:1232-1263`
     (`@@unique([tenantId, invoiceId, agentId])` at 1258 — "the double-accrual lock",
     confirmed present, matches plan's description of the create-path backstop).
   - `CommissionAdjustment` model: `apps/api/prisma/schema/sales.prisma:1264-1283`
     (only `@@index([agentId])`, `@@index([accrualId])`, `@@index([tenantId])` at
     1280-1282 — **confirmed no `@@unique`**, matching the plan's claim, just at new
     line numbers).
   - `TenantAddon.stripeItemId` was NOT located in this pass — S2 should grep
     `platform.prisma` (per CLAUDE.md's architecture note that `TenantAddon` lives
     there) for the exact current line before citing it.
2. **The cron is no longer a bare `@Cron`.** `commission-reconciliation.service.ts`
   was touched by `1ebd4f54` (#623, "leader-elected crons via advisory locks",
   2026-09-05/06) — it is now `@LeaderCron("30 * * * *",
"commission-reconciliation.reconcileCommissions")`, not the plain `@Cron(30 * * *
   - *)`both`F18.md`and`B73.md`cite. **This postdates the plan's`e5b0af8e`round
sha AND is not flagged in`corrections-F18.md`** — it is a genuinely new staleness
delta S2 must account for. Whether `@LeaderCron`'s per-job advisory lock changes
B73's exposure (e.g. does it serialize overlapping runs of the SAME cron job across
replicas, which would narrow but not eliminate the race — the hook-vs-cron overlap
the plan actually targets is unaffected either way) needs a read of
`apps/api/src/common/cron-lock.ts`, not yet done in this pass.
3. **F09 collision surfaces** (`corrections-F18.md` §4): `apps/web/playwright.config.ts`,
   `apps/api/src/invoices/invoices.service.ts` (17 of the 22 commission-sync call
   sites), and the code-map files (`api.md`/`web.md`/`_meta.json`) are named as
   concurrent-batch collision risk. This pass did not check whether `rf-F09`'s branch
   has already landed on this tree (the worktree is pinned to `master 597c72dc`, and
   the session's own `git log` shows `#623`/`#624`/`#625`/`#626`/`#627` already merged
   past the plan's `e5b0af8e` baseline) — S2 should re-grep the 22 call-site line
   numbers the plan cites (`bookkeeping.service.ts:227`, `customers.service.ts:1230`,
   `invoices.service.ts:1457,1879,3879,3995,4117,4484,4668,4839,4907,4952,5114,5202,
5341,5645`, `orders.service.ts:5480`, plus the Serializable-block sites
   `invoices.service.ts:3448/3654`, `credit-notes.service.ts:256/566/603/1059`) before
   relying on any of them — none were re-verified in this pass.
4. **The lesson id (`L-049`) is confirmed void** by `corrections-F18.md` §2 —
   `_meta.json.nextId` should be re-read at close-out time, not assumed from this
   brief's writing time.
5. **Web-side test coverage for B58 is unconfirmed.** This pass did not enumerate
   `apps/web` `.test.tsx` files for `choose-plan/page.tsx` or `settings/billing/page.tsx`
   — S2 should grep before assuming zero web-side unit coverage exists (only the E2E
   spec-33 gap and the jest spec-130 mis-scoping were verified directly).
6. **The owner ruling referenced in the task's CONTEXT** ("ACTIVE -> subscribe(lower
   plan, same cycle) IS A BUG, so the plan's variant (a) applies") was supplied by the
   orchestrating agent's instructions, not found as text inside `B58.md`, `F18.md`, or
   `corrections-F18.md` — `corrections-F18.md` §5 explicitly says "The registry itself
   (B58.md) contains no owner-ruling text. The real question lives only in the plan."
   This brief treats the ruling as given per task CONTEXT; S2 should not re-derive or
   re-litigate it from the registry/plan text alone, since those sources describe it
   as an open question, not a decision.
