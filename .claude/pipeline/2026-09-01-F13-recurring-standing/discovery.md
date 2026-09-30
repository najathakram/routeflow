# Discovery — why F13 · Recurring invoices and standing orders

**Status:** `APPROVED` (autonomous campaign batch — the owner approved the burn-down plan; the fleet lead launches S7)
**Stage:** S1 — Discovery (why) · **Author:** Fable 5 · **Date:** 2026-09-01
**Lives at:** `.claude/pipeline/2026-09-01-F13-recurring-standing/discovery.md`
**Next:** [spec.md](./spec.md)

> **This file is the only context downstream agents receive about _why_ this work exists.**
> Everything a downstream agent needs is written here in full — no chat history, no ticket.
> Repo: RouteFlow monorepo (NestJS API `apps/api`, Next.js web `apps/web`, Expo mobile
> `apps/mobile`). Worktree for this batch: `C:\ClaudeCode\routeflow\.claude\worktrees\rf-F13`,
> branch `fix/F13-recurring-standing`, cut from `origin/master` at `3d1d8ea9`. **Every claim
> below was re-derived on that SHA by reading the file** — the register's line citations were
> a hypothesis, not evidence (lessons L-026, L-031).

---

## 0. Bug-by-bug classification (the discovery deliverable)

The campaign card (`.claude/pipeline/fix-cards/F13-recurring-invoices-standing-orders.md`)
flagged four of the five citations `OUT_OF_BOUNDS` at the re-anchor pass (`master@6c8f1401`).
**That verdict was a re-anchor parser artifact, not code drift.** Every cited file has the
_identical_ line count at `6c8f1401` and at `3d1d8ea9` (checked with `git show <sha>:<path> |
wc -l` for all eight files), and every cited line lands on exactly the code the register
describes. Nothing on the API side moved; the two services were last touched by #373 and #356.

| ID       | Sev      | Tier | Classification on `master@3d1d8ea9`      | Evidence (re-read, not cited)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | -------- | ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B46**  | Critical | T1   | **CONFIRMED**                            | `apps/api/src/recurring-invoices/recurring-invoices.service.ts:31-39` — MONTHLY branch does `d.setDate(1)` (:33) _before_ `if (d.getDate() > dom)` (:36), so the compare is always `1 > dom` ⇒ false; the month never advances. Hand trace: from `2026-07-15`, dom 15 → `d=07-16` → `setDate(1)=07-01` → `1>15` false → `setDate(15)` → returns **2026-07-15, unchanged**. The CAS claim (:174-178) writes that unchanged value as `nextRunAt`, so the midnight cron's `nextRunAt lte now` filter (:242) re-selects the template every night; with `autoSend` the customer is emailed a new invoice daily (:205-214). The only month in which it works by accident is a non-leap February with dom 28 (the `+1 day` crosses the month boundary). `recurring-invoices.service.spec.ts:184` asserts only `toBeInstanceOf(Date)`. The DTO caps dom at 1–28 (`dto/create-recurring-invoice.dto.ts:31`), so this is the default outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **B48**  | Critical | T1   | **CONFIRMED**                            | `apps/api/src/order-templates/order-templates.service.ts:352` — `const unitPrice = Number(product.pricePerUnit)`; no `customer.pricingTier`, no `CustomerPrice`, no promotion, no price-history lookup anywhere in `createOrderFromTemplate` (:309-412). Lines persist with the `OrderItem` defaults `priceType STANDARD`, `originalPrice null`, `promoFreeUnits null`. Contrast the interactive path `apps/api/src/orders/orders.service.ts:1708-1770` (tier + CustomerPrice + promos + sticky-upsell history) and its resolver `resolveBuyerLinePrice` (:137-209). **Reachable from three triggers** (L-029 sweep): the 06:00 cron `generateDailyOrders` (:251-307), the operator "Generate order now" button (`apps/web/app/(dashboard)/customers/[id]/page.tsx:3491-3497` → `POST /order-templates/:id/generate`, `order-templates.controller.ts:84-89`), and the buyer "Reorder" (`apps/api/src/buyer/buyer.controller.ts:857-873` → `generateOrder`). **A fourth path the register missed:** `createOrderFromTemplate` ends by calling `ordersService.mergeAllPendingForCustomer` (:410); the merge's winner is the _newest_ PENDING order — the just-created list-priced template order — and overlapping product lines keep the **winner's** unitPrice (`orders.service.ts:814-1010`), so a correctly-priced pending cart line for the same product is re-billed at list when the standing order lands. Fixing the template order's own prices fixes this path too (the winner then carries the right price). |
| **B106** | High     | T1   | **CONFIRMED — F01 dependency satisfied** | Claim stamps `nextRunAt` + `lastRunAt` first (`recurring-invoices.service.ts:175-178`); `invoicesService.create` afterwards (:184-198); the cron's catch only logs (:250-258); `totalFail` is logged, never stored (:263-265). `runNow` (:158-165) shares the same body, so a manual retry after a failure claims the _next_ cycle. The register's "`schema.prisma:2746-2768` — no error/status field" is **superseded**: F01 added `RecurringInvoice.lastRunStatus String?` and `lastError String?` (`apps/api/prisma/schema.prisma:2801-2806`) with the comment `F13 wires the writes. Values (F13): "SUCCESS" \| "FAILED"` — **that comment is the storage spec** (L-035). `grep -rn lastRunStatus apps/api/src apps/web apps/mobile` → **zero readers or writers**. Web renders `lastRunAt` as "Last run" with no outcome (`apps/web/app/(dashboard)/invoices/recurring/page.tsx:163-168`). **Mobile sibling:** `apps/mobile/app/(operator)/recurring-invoices/[id].tsx:124` renders `· Last run <date>` with the same silence, and `apps/mobile/lib/recurring-invoices-logic.ts` is the jest-tested pure-logic home for the mirror.                                                                                                                                                                                                                                                                                                                                                                              |
| **B09**  | High     | T2   | **CONFIRMED**                            | `apps/web/app/(dashboard)/customers/[id]/StandingOrderModal.tsx:301-392` renders the product search / add / qty-stepper / remove UI with no `isEditing` gate; `handleSubmit`'s edit branch (:179-194) sends `{id, name, daysOfWeek, notes}` only — the comment at :180 admits it. `useAddTemplateItem` / `useRemoveTemplateItem` (`apps/web/lib/api/order-templates.ts:92,107`; mobile copies at `apps/mobile/lib/api/order-templates.ts:131,144`) have **no caller** in web or mobile (repo grep). Server side: `PATCH /order-templates/:id` (`order-templates.controller.ts:48-57`) takes `UpdateOrderTemplateDto` (`dto/update-order-template.dto.ts`) which has **no `items`** — and the global `ValidationPipe` is `forbidNonWhitelisted`, so an `items` key would be rejected 400 today. There is **no qty-update endpoint** (only add `POST :id/items` and remove `DELETE :id/items/:itemId`). Mobile's template screen (`apps/mobile/app/(operator)/order-templates/[id].tsx`) has pause/resume/generate/delete only — no item UI, so **no mobile sibling**.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **B92**  | Medium   | T2   | **CONFIRMED**                            | `apps/web/app/(dashboard)/invoices/recurring/` holds only `page.tsx` (list: Run Now + pause/activate, :171-189) and `new/page.tsx`; no `[id]` route. `useRecurringInvoice` (`apps/web/lib/api/invoices.ts:797`) and `useUpdateRecurringInvoice` (:813) have **no caller** (repo grep). The API `PATCH /recurring-invoices/:id` exists (`recurring-invoices.controller.ts:40-43` → `service.update` :103-140, items replaced by deleteMany + nested create). **New finding the register missed:** the controller types the body as `Partial<CreateRecurringInvoiceDto>` — a TypeScript mapped type erases to `Object` in `design:paramtypes` (verified in the compiled main-checkout `apps/api/dist/recurring-invoices/recurring-invoices.controller.js:77` → `[String, Object]`), and Nest's `ValidationPipe` **skips `Object` metatypes entirely**. So the PATCH body is **unvalidated and un-whitelisted today**; the comments at `recurring-invoices.controller.ts:50-52` and `apps/web/lib/api/invoices.ts:835-837` claiming the PATCH "validates against CreateRecurringInvoiceDto" are wrong (the `{isActive:true}` PATCH "never persisted" because `update()` doesn't map it, not because it was rejected). An edit page that PATCHes `items` therefore needs a real `UpdateRecurringInvoiceDto` first or malformed numbers reach Prisma as 500s. Mobile has `recurring-invoices/new.tsx` but no edit screen — a mobile mirror is a whole screen, deferred (§10).                                              |

**Outcome:** 5 CONFIRMED, 0 ALREADY FIXED, 0 EVIDENCE MOVED. The four `OUT_OF_BOUNDS` flags
are corrected to _in-bounds, parser artifact_ (record this in the register's citation notes at
close-out). B106's schema citation is superseded by F01's columns (the dependency the card
named is satisfied).

## 1. The problem, in the requester's own words (G1·Q1)

> "The two daily crons. calcNextRunAt's MONTHLY branch has dead month-advance code, so every
> monthly template re-fires EVERY midnight with autoSend emailing a fresh invoice daily (B46);
> template-generated orders bill raw list price, ignoring tier, overrides and promotions (B48);
> a failed cycle is claimed and then silently skipped (B106)." — F13 fix card, root cause.
> Plus: "Standing-order edits silently drop item changes" (B09) and "Recurring invoice
> templates cannot be edited after creation" (B92).

**Restated in our words:** the two recurring engines (monthly recurring _invoices_ and daily
standing _orders_) each have a defect in the thing they exist to do — the invoice engine bills
every night instead of every month and hides its own failures; the order engine bills the
wrong price. Around them, the two editing surfaces operators would use to correct a template
either throw the edit away (standing-order items) or do not exist (recurring invoices).

**Source:** the bug register (`local-assets/docs/routeflow-bug-register.html`, entries B09,
B46, B48, B92, B106 — hunt rounds `2d0270fd`/`e5b0af8e`/`0cd59277`), seeded into the
campaign as batch F13 (board issue #526, Wave A — every Critical).

## 2. Who has this problem (G1·Q1)

| Role                                                                                                                 | How often they hit it                                                    | What it costs them today                                                                                                                                      | How we know                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant's customer with a MONTHLY recurring invoice + autoSend                                                        | **every midnight** after the first run                                   | a duplicate invoice (and email) per day, indefinitely; an operator has to void them (and voiding a DRAFT with ledger rows is itself a money op — L-031)       | code trace §0; `scripts/data-integrity-report.mjs` check `recurring-duplicate-fire` exists for exactly this footprint (A1 — whether it has fired in prod is unmeasured) |
| Customer on a discounted tier / negotiated CustomerPrice / with an active promo, using a standing order              | every generated order (daily cron, reorder tap, operator "Generate now") | overcharged by (list − tier/override/promo) per unit, silently, on the buyer's own reorder; their existing pending cart can be re-priced to list by the merge | code trace §0                                                                                                                                                           |
| Operator whose recurring template's invoice creation fails (customer deleted, invoice-number conflict, ledger error) | rare, but invisible when it happens                                      | the customer is never billed for that period; "Last run" reads as success; the fix ("Run now") then skips the _next_ cycle                                    | code trace §0                                                                                                                                                           |
| Operator editing a standing order's items in the web modal                                                           | every edit attempt                                                       | the change is shown, "Standing order updated" toasts, nothing saved; the only real path is delete + recreate                                                  | code trace §0                                                                                                                                                           |
| Operator who needs to change a recurring template (price, schedule, typo)                                            | every change                                                             | delete + rebuild the template; no other path exists                                                                                                           | code trace §0                                                                                                                                                           |

## 3. What they do instead today (G1·Q2)

- **B46:** void the duplicates by hand, every morning, or pause the template (defeating it).
- **B48:** nothing — nobody knows; the overcharge is discovered by the customer, if at all.
- **B106:** nothing — the missed period is invisible; the code comment's own recovery
  ("recoverable via runNow") skips the following cycle.
- **B09:** delete the standing order and recreate it with the new items.
- **B92:** delete the recurring template and recreate it.

Every workaround is destructive (loses history/ids) or invisible (money). None scales.

## 4. Why now (G1·Q3)

Wave A of the bug-register burn-down owns "every Critical"; B46 and B48 are two of the eight
open Criticals holding Wave A open (fleet state 2026-09-01). F01 landed the `lastRunStatus`/
`lastError` columns _for_ this batch on 2026-08-30 — they are a contract with no writer until
F13 ships (L-035). **Deadline:** none external; the Wave A gate.

## 5. If we ship nothing (G1·Q4)

Every tenant with a MONTHLY autoSend template keeps spamming its customer nightly; every
tiered/override/promo customer with a standing order keeps being overcharged on every cycle,
including on their own "Reorder" tap; and any failed recurring cycle keeps going unbilled with
a UI that says it ran. All three are money or customer-trust defects that compound daily.
**Materially bad — proceed.**

## 6. Success signal — one, observable (G1·Q5)

| Signal                                                                                                                                                                                                                                                                                          | Today's baseline                                                                                                                                   | Target                                                                       | Where measured                                                                                | When                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `scripts/data-integrity-report.mjs` check `recurring-duplicate-fire` returns **0 new rows** created after deploy, and the new check `template-order-list-price-vs-tier` returns **0 rows for orders created after deploy** — while the gate-state check shows the gates OPEN (positive control) | unmeasured on prod (A1); by construction any MONTHLY template that has fired re-fires nightly, and any tiered customer's template order is at list | 0 post-deploy rows with open gates, across two consecutive nightly cron runs | `railway run --service postgres node scripts/data-integrity-report.mjs --verbose` (read-only) | 2 days after deploy, then at Wave A close |

The T1/T2 proofs (REG-B46/B48/B106/B09/B92) are the pre-deploy oracle; this is the
post-deploy one.

## 7. Everyone else affected that nobody asked (G1·Q6)

| Party                                                 | How this touches them                                                                                                                                                                                                                                                                      | What they need from us                                                                                                        | Consulted?                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Finance / billing (per tenant)                        | historical overcharges (B48) and duplicate invoices (B46) already exist in prod data; D4 says repair-as-we-go                                                                                                                                                                              | a **report** of candidates (D4 dry-run) — repair of delivered/invoiced orders is a money decision for the owner, not a script | via campaign decision D4                                               |
| Buyer-portal users                                    | "Reorder" now bills their real price (a _decrease_ for discounted customers; a sticky-upsell customer keeps their remembered price, same as manual checkout)                                                                                                                               | nothing — it is the price they already see in the shop                                                                        | n/a                                                                    |
| Mobile operators                                      | the recurring detail screen gains the outcome pill (severable mobile package); standing-order items still not editable on mobile (no UI exists)                                                                                                                                            | nothing                                                                                                                       | coordinator directed: include the mobile mirror where a surface exists |
| F14 (authorization batch)                             | owns `order-templates.controller.ts` (`@Roles` narrowing for DRIVER — B133). F13 does **not** touch that file; it extends the PATCH **DTO** + service only, and adds no capability a DRIVER lacks today (add/remove item routes already exist)                                             | lane note recorded                                                                                                            | yes — lane note in the card                                            |
| F11 (in flight, `rf-F11`)                             | owns `routes.service.ts` + `orders.service.ts (getOrderTracking)`. F13 changes **two access modifiers** in `orders.service.ts` (`resolveBuyerLinePrice`, `loadActivePromotions` → public) so one pricing resolver serves both paths instead of a second copy (L-008: surfaced, not hidden) | the lead brokers the rebase; a one-word-per-line diff in a different region                                                   | flagged in the report                                                  |
| F25 (buyer-portal templates page) / F09 (e2e spec 28) | disjoint web surfaces; F13's e2e spec number is **proposed 29**, unconfirmed                                                                                                                                                                                                               | the lead allocates the number before authoring                                                                                | flagged                                                                |

## 8. Root-cause check — is this a symptom? (G1·Q7, G1·Q8)

- **Symptom or cause:** five independent root causes, one per bug — a dead branch (B46), a
  bypassed pricing pipeline (B48), a swallowed exception with no persisted state (B106), a
  submit handler that omits state it renders (B09), a missing route over a working API (B92).
- **Would fixing something deeper delete the request?** No. The two engines are separate
  services with separate crons; there is no shared abstraction whose fix covers both.
- **Are we solving the problem or building the picked solution?** The card's suggested fixes
  were checked against the code, and two were adjusted: (1) B106's "optionally roll the claim
  back" is **adopted**, because `invoicesService.create` commits the invoice and its ledger rows
  in ONE `tenantTransaction` (`invoices.service.ts:475-530`) with no post-commit step on this
  path (it never passes `send`), so a throw means no invoice exists and restoring `nextRunAt`
  cannot mint a duplicate — while _keeping_ the claim would make "Run now" skip the following
  cycle. (2) B09's "hide the item controls in edit mode" alternative is **rejected**: it makes
  the modal honest but leaves standing orders un-editable; wiring `items` through the PATCH is
  the smaller honest fix and needs no new route.
- **Prior art:** `orders.service.ts:1708-1770` + `resolveBuyerLinePrice` is the pricing
  pipeline every other order path uses; `recurring-invoices.service.ts:103-140 update()` is
  the item-replacement pattern B09 mirrors; `apps/web/app/(dashboard)/invoices/recurring/new/page.tsx`
  is the form B92's edit page reuses; `apps/api/src/promotions/dto/update-promotion.dto.ts`
  is the `PartialType` precedent for the recurring update DTO.

## 9. Riskiest assumption and the cheapest way to kill it (G3·Q1, G3·Q6)

| #   | Assumption                                                                                                                                        | If wrong                                                                                                               | Cheapest check                                                                                                                                                                                                                              | Cost  | Result                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------- |
| A2  | `invoicesService.create` cannot throw _after_ committing an invoice on the recurring path (so rolling the claim back on a throw never duplicates) | rollback would re-bill a cycle that already produced an invoice — the exact duplicate the B9 claim-first design closed | read `invoices.service.ts:466-538`: the only post-tx code is `if (dto.send) return this.send(...)`; the recurring path never sets `send`                                                                                                    | 2 min | **held** (2026-09-01)                         |
| A3  | `resolveBuyerLinePrice` uses no `this` and can be shared with the template service by making it public (no second copy of money logic)            | a copy would drift (the house's "three mirrors" rule)                                                                  | read `orders.service.ts:137-209`: only module imports (`getTierPrice`, `applyBestPromotion`, `roundMoney`, `PriceType`) — no `this`                                                                                                         | 1 min | **held**                                      |
| A4  | `@nestjs/mapped-types` resolves from `apps/api` although it is not a direct dependency                                                            | `UpdateRecurringInvoiceDto` fails to compile                                                                           | two shipped DTOs already import it (`promotions/dto/update-promotion.dto.ts:1`, `suppliers/dto/update-supplier.dto.ts:1`) and the API builds; confirm with `node -e "require.resolve('@nestjs/mapped-types',{paths:['apps/api']})"` (L-028) | 1 min | held by precedent; command re-run at Baseline |

## 10. Non-goals — the scope fence (G2·Q5)

- **No mobile edit screen** for recurring templates (B92 mirror) and no mobile item editing
  for standing orders — mobile has neither surface today; the mobile change is limited to the
  B106 outcome pill (severable package). Record both as follow-ups.
- **No email-failure surfacing** through `lastError` — the autoSend failure keeps its existing
  log-and-leave-DRAFT behavior; `lastError` is non-null iff `lastRunStatus === "FAILED"`.
- **No `categoryTaxAmount` on template lines** — `createOrderFromTemplate` hard-codes 0 while
  `orders.service.create` computes regulated category tax; a pre-existing sibling gap,
  **recorded for the register, not fixed here** (L-008).
- **No role narrowing** on order-template routes (F14's B133).
- **No historical repair apply** — D4 report only; re-pricing delivered/invoiced orders and
  voiding duplicate invoices are owner decisions (promotion-based overcharges are
  unidentifiable in hindsight and are recorded as such).
- **No customer change** on a recurring template via edit (`update()` never mapped it).
- **No clearing of the inactive day field** when frequency switches (a stale `dayOfWeek` on
  a MONTHLY template is inert — `calcNextRunAt` never reads it).
- **No change to WEEKLY/BIWEEKLY** scheduling (pinned byte-identical).

## 11. Open questions for the requester

| #   | Question                                                                               | Unblocks                                                                                         | Blocking S2? | Answer / assumption                                                                                                        |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Q1  | e2e spec number                                                                        | filename + `playwright.config.ts` entry                                                          | no           | **proposed 29** (28 → F09); placeholder used until the lead confirms                                                       |
| Q2  | keep the mobile B106 mirror in this PR?                                                | WP-MOBILE + its verify commands (needs an isolated `npx -y npm@10.8.0 ci` in the worktree first) | no           | included per the coordinator's directive; severable in one edit of `workflow-args.json`                                    |
| Q3  | may F13 touch `orders.service.ts` (two modifiers) while F11 owns another region of it? | one shared resolver vs a copy                                                                    | no           | assumed yes (surfaced per L-008); fallback is a `(this.ordersService as any)` call, rejected as a smell — the lead decides |

## 12. Assumptions (unverified) — MANDATORY

| #   | Claim (§)                                                                                                                                               | Basis                                                                                                                                       | What would confirm it                                                                                                                                | What breaks if wrong                                                                                                                                                            | Status                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| A1  | §2/§6: prod actually has fired MONTHLY templates and tiered customers with standing orders (i.e. the damage predicates are non-vacuous)                 | inferred from code; unmeasured                                                                                                              | `scripts/data-integrity-report.mjs` new check `f13-gate-state` (rows = closed gates) run read-only on prod                                           | only the _size_ of the historical damage; the fixes stand regardless                                                                                                            | unverified — post-deploy                     |
| A2  | §8: no post-commit throw in `invoicesService.create` on this path                                                                                       | read `apps/api/src/invoices/invoices.service.ts:466-538`                                                                                    | same read                                                                                                                                            | rollback could duplicate an invoice → revert to "keep the claim, record FAILED" (spec R12 alternative)                                                                          | confirmed 2026-09-01                         |
| A3  | §8: `resolveBuyerLinePrice` / `loadActivePromotions` need only a visibility change to be shared                                                         | read `apps/api/src/orders/orders.service.ts:115-209`                                                                                        | `cd apps/api && npx tsc -p tsconfig.build.json --noEmit` after the edit                                                                              | a copy of the resolver would be needed                                                                                                                                          | confirmed 2026-09-01                         |
| A4  | §8: `@nestjs/mapped-types` resolves from `apps/api`                                                                                                     | two shipped imports                                                                                                                         | `node -e "console.log(require.resolve('@nestjs/mapped-types',{paths:['apps/api']}))"`                                                                | add the direct devDependency (workspace-level, per L-012)                                                                                                                       | held by precedent                            |
| A5  | §0: the four `OUT_OF_BOUNDS` verdicts were parser artifacts                                                                                             | identical `wc -l` at both SHAs for all cited files; every cited line re-read                                                                | already done                                                                                                                                         | nothing — the code was read directly either way                                                                                                                                 | confirmed 2026-09-01                         |
| A6  | §0: the PATCH `/recurring-invoices/:id` body is unvalidated today                                                                                       | compiled `design:paramtypes` `[String, Object]` in the main checkout's `dist` (built 2026-08-21; the controller has not changed since #170) | the new DTO spec's "rejects `{isActive:true}`" test is RED before the DTO lands only if validation is absent today — the red gate itself confirms it | if validation _were_ present, the DTO change is still correct (it names the real contract)                                                                                      | confirmed by dist read; red gate re-confirms |
| A7  | §7: F14 will not also add `items` to the order-template PATCH DTO                                                                                       | F14's card names controllers only                                                                                                           | the lead's rebase                                                                                                                                    | a trivial merge conflict in one DTO file                                                                                                                                        | unverified — lead                            |
| A8  | §0: the Railway server runs in UTC, so `calcNextRunAt`'s local-midnight arithmetic equals the stored UTC-midnight `nextRunAt` convention the web writes | Docker default; the web comment `nextRunAt is a UTC-midnight calendar date` (`recurring/page.tsx:157`)                                      | `railway ssh` `date`                                                                                                                                 | a non-UTC server would shift the day boundary by the offset — pre-existing, unchanged by this batch; tests use local-time constructors and compare Y/M/D so they hold in any TZ | unverified — pre-existing                    |

---

## STOP GATE — S1 → S2

- [x] Problem stated in the requester's own words and restated in ours
- [x] User named: role + frequency + cost today
- [x] Current workaround named, and why it fails
- [x] One observable success signal with today's baseline (unmeasured — stated as such)
- [x] "If we ship nothing" answered honestly
- [x] Root-cause check done — five independent causes; two suggested fixes corrected
- [x] Riskiest assumption named and killed (A2, A3 read; A4 by precedent)
- [x] Non-goals written down
- [x] Every blocking open question answered or assumption recorded (none blocking)
- [x] Assumptions block filled

## Stage log — did the gate fire?

| Stop condition                                 | Evaluated? | What it answered                                                           | Evidence   | Verdict |
| ---------------------------------------------- | ---------- | -------------------------------------------------------------------------- | ---------- | ------- |
| Shipping nothing is materially bad             | yes        | nightly duplicate invoices + silent overcharges compound daily             | §5         | pass    |
| The ask is a cause, not a symptom              | yes        | five separate root causes, each read in the code                           | §0, §8     | pass    |
| User, workaround and success signal all stated | yes        | per-role table; destructive/invisible workarounds; integrity-report signal | §2, §3, §6 | pass    |
| Every blocking open question answered          | yes        | none blocking; Q1–Q3 carried as assumptions                                | §11        | pass    |

- **Gate outcome:** PASS — S2 may start
- **Assumptions carried into S2:** A1, A4, A7, A8

**Approved by:** owner-approved campaign plan (autonomous batch) · **on:** 2026-09-01
