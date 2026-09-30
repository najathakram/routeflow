# Hunt classes — the catalogue, with measured yields

One agent per class. **Never split by area** ("audit invoices") — split by defect _shape_
("find every place money is re-derived"). Area splits re-find what reading a screen already shows;
class splits find what it never would.

Yields below are from three real rounds against this repo (95 registered findings). `→ B##`
names findings a class actually produced.

---

## Tier A — highest critical yield (run these first)

### A1 · Conservation invariants · **Fable**

Money, customer credit/advance, and inventory must each balance across _any_ sequence of
create/edit/split/void/write-off/pay/refund/cancel/delete. Method: enumerate every writer of a
balance, then check each has a working inverse. Construct adversarial sequences, don't just read.
→ B53 (returns refund ordered-not-delivered qty), B64–B69, B81, B82.
Ask specifically: _which path books this, and which path un-books it — and do they agree to the cent?_

### A2 · State-machine reachability · **Fable**

Model each lifecycle (Order, Invoice, CreditNote, Return, RouteRun/Stop, Estimate): every status,
every transition the **server** allows, versus what each **client** offers. Hunt transitions that
reach a corrupt or self-contradictory state.
→ B56 (cancel a partially-delivered order voids the delivered invoice), B70, B71, B72.
The bug is rarely a missing status; it's a missing _guard between_ two legal statuses.

### A3 · Cross-surface semantic drift · **Opus**

The same business operation implemented on web, mobile, buyer portal, and API — find where they
produce **different results for the same inputs**, or one enforces a rule another skips.
→ B47 (buyer merge conflates boxes and pieces), B49, B50, B78.
Distinct from constant/enum mirror drift (Tier B): this is _behavioural_ divergence.

### A4 · Shared-mirror logic bugs · **Fable**

Money/line/tax math lives once in `packages/pricing` (`@routeflow/pricing`) — there are no copies
to drift, but a bug sitting in that single shared implementation is invisible to a drift check by
construction. Audit the shared algorithm against its contract and its spec, with numeric
counter-examples you actually compute: boxed proration with uneven division, freeUnits interaction,
rounding accumulation (does the total equal the sum of rounded lines, or the rounded sum?).
Same question applies to `trip-grouping.ts` and `payment-methods.ts`.

### A5 · Concurrency, retries, idempotency · **Opus**

Double-submit on money mutations; webhook vs UI races; offline-queue replay ordering; concurrent
edits from two surfaces; cron overlap and restart double-fire.
→ B46 (monthly recurring invoices re-fire daily — the worst critical found), B73.
Verified sound here: Stripe settlement, credit apply/restore, recurring-invoice CAS claim — see the
register's cleared section before re-testing these.

### A6 · Background jobs & scheduling · **Fable**

Every `@Cron`: does its "claim" actually advance past now? Is it idempotent on restart? What
happens on a missed window, DST, or a tenant in another timezone? Trace the _next-run_ arithmetic
by executing it on concrete dates.
→ B46. The dead-branch bug there (`setDate(1)` before testing `getDate() > dom`) is signature #18.

---

## Tier B — high volume, reliable (Sonnet, behind a strong verifier)

### B1 · Money math & rounding

`qty * unitPrice` re-derivation outside `pricing.ts`; writes not passed through `roundMoney`;
`promoFreeUnits` lost on delete-and-recreate edit paths; discount-convention violations
(net unitPrice + originalPrice, never re-derived).
→ B48, B49, B50, B57, B60, B62.

### B2 · Mirror & constant drift

`no-mirrors.spec.ts` gates import specifiers and the deleted legacy files; a re-implementation is
found by grepping for local `roundMoney`/`computeLineSubtotal` definitions outside
`packages/pricing`. Then diff `payment-methods.ts` vs the Prisma enum, status/type unions in
`lib/api/*.ts` vs schema enums, `format.ts` vs `formatting.ts` adoption. → B59, B91.

### B3 · Dates, timezones, period bucketing

UTC-midnight calendar dates rendered with local-time formatters (one day early west of UTC);
inclusive/exclusive range ends; backdating chains; settled-vs-paid filters. → B59, B89, B90, B91.

### B4 · Dropped data

DTO fields validated but never persisted; form fields collected but omitted from the payload;
PATCH paths that delete-and-recreate children and lose fields absent from the recreate set.
→ B20, B27-adjacent, B78, B88.

### B5 · Dead / unreachable UI (web and mobile — run as two agents)

Impossible enum branches, options the server rejects, buttons enabled when they can only fail,
components nothing imports, hooks with zero callers. → B10, B15, B16, B18, B31, B79, B80, B94, B95.

### B6 · Cache invalidation & staleness

Mutations invalidating the wrong or no query keys; detail pages not refreshed after child writes;
socket handlers updating some caches but not others. → B76, B77, B86.

### B7 · Tenant isolation & authorization

Tenant-scoped queries without a `tenantId` condition; IDOR; client-supplied prices trusted;
missing role guards a sibling endpoint has; upload/storage key scoping. → B51, B52, B63.

### B8 · Lifecycle sync (order ↔ invoice)

Writes that skip `reconcileOrderDraftInvoice` / `recomputeOrderFromInvoices`; status guards
missing an atomic claim their neighbours carry. → B74, B84, B85.

### B9 · Driver write paths

The at-door sequence end to end: adjust/short-pick math, payment close-out ordering, settlement,
new-order-at-stop, return-at-stop. → B49, B50, B54, B55, B61, B83.

### B10 · Buyer portal & promotions

Cart vs tile vs server price parity; promo edges (ties, expiry mid-session, freeUnits caps);
replenishment maths; multi-seller context bleed. → B47, B77.

### B11 · Regulated / compliance

Excise dropped or double-applied along order→invoice→report; period restatement; products moving
in or out of Regulated mid-period. → B57, B65.

---

## Tier C — classes opened in round 3 (fresh ground, verify yields)

- **Data model & migrations** (_Fable_) — money-column precision, missing unique constraints,
  nullable columns the code always dereferences, cascade behaviour, indexes for real-size tenants,
  `ALTER` without backfill so prod rows differ from what the schema promises.
- **Generated documents** (_Sonnet_) — invoice PDFs, statements, emails. Money re-derived in a
  template; fields on screen but missing from the PDF; letterhead resolution; attachment failures
  swallowed. Entirely unaudited before round 3.
- **Import / CSV pipeline** (_Sonnet_) — numeric coercion, duplicate re-import, partial-batch
  commit, encoding, rows bypassing the normal create path's validation.
- **Realtime / socket authorization** (_Sonnet_) — room scoping, handshake auth, over-broad event
  payloads, client handlers applying events from the wrong tenant context.
- **Swallowed failures** (_Opus_) — catch blocks and warn-only paths where the swallow means money
  or data is silently wrong. → B83 was one instance; the pattern is broader.
- **Scale-driven wrongness** (_Sonnet_) — capped fetches aggregated client-side, N+1s, pagination
  hiding data in pickers, jobs that die on a large tenant. Not slowness — _wrongness_. → B12.
- **Freshly merged code** (_Opus_) — after any merge train, the new surface has never been audited
  and prior line numbers have drifted. Diff the merges and read with fresh eyes.
- **Forensic data integrity** (_Fable_) — find the database _footprints_ of bugs that already
  fired, rather than code paths. Deliverable is `scripts/data-integrity-report.mjs` (read-only,
  IDs and counts only, never customer data). Detection by damage, not by reading.

---

## Classes deliberately retired

- **Per-screen documentation sweep** — round 1's method. Excellent for finding dead controls and
  missing UI (45 findings), now exhausted; the guide already documents every screen.
- **Driver order-edit wipe** — proven guarded on both sides. In the cleared section. Stop chasing it.

---

## Choosing classes for a run

Read the register's coverage first. Then, in order of preference:

1. A class **never run** (Tier C, or a new one you can name) — always the best yield.
2. A class whose **subject code changed** since it last ran (merge train, refactor, new module).
3. A Tier A class re-run with a **different adversarial angle** — worthwhile, diminishing.
4. A second pass over a hunted Tier B class — lowest yield; do this last, if at all.
