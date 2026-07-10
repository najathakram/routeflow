# P5 / P6 / P10 — Session Handoff (Buyer Portal · Messaging · Mobile Deltas)

> **Self-contained resume doc for the P5/P6/P10 build program.** A new session (even a
> different Claude profile without this project's auto-memory) can start from this file alone.
> **Keep it current — see [§ Maintenance](#maintenance) at the bottom. Update it at the end of
> every increment before you finish.**
>
> **Last updated:** 2026-07-09 — P10-PAR-6 mobile Finance Reports parity COMPLETE + LIVE (#176, master `f1ff301`).
> **This closes the whole P10-PAR parity track** (estimates/credit-notes/recurring/payments/order-templates/reports
> all shipped). The next targets are P6-3 (blocked on provider creds) and P6-5 — see DO NEXT.
> Prior: P10-PAR-5 order-templates (#173), P10-PAR-4 payments (#172), recurring resume FIX (#170), P10-PAR-3,
> P10-PAR-2 (#168), P6-2 (#167), P10-PAR-1 (#165), P6-1/F0 (#163), P5-01 (#159) live.
> ✅ **Railway GitHub auto-deploys
> FIXED** — the failures were flipping the repo private before Railway cloned it. Follow the canonical
> **public → merge → deploy (WAIT, still public) → private** flow (CLAUDE.md). No App reinstall needed.

---

## Kickoff prompt (paste to start the next session)

```text
Continue the RouteFlow P5/P6/P10 build program (Buyer Portal / Messaging / Mobile Deltas).
Working dir: C:\ClaudeCode\routeflow — npm+Turbo monorepo (apps/api NestJS+Prisma+Postgres,
apps/web Next.js = golden reference, apps/mobile Expo mirrors web). Deploy: Railway.

READ FIRST: docs/design-package/SESSION-HANDOFF-P5P6P10.md (this doc — state + next steps),
docs/design-package/PHASE-5-6-10-PLAN.md (the ~55-increment plan + 18 gating decisions; proceed on
defaults), CLAUDE.md + CLAUDE_SESSION_PREAMBLE.md, .claude/code-map/INDEX.md → area file.

Then do the "DO NEXT" increments below, in order, RouteFlow cadence: one branch/PR per increment,
npm run verify → adversarial review for money/schema paths → deploy per increment. Check in after each
increment is deployed. Before you finish, update this doc's CURRENT STATE + DO NEXT (see Maintenance).
```

---

## Current state

- **P10-PAR-6 COMPLETE + LIVE** (PR #176, master `f1ff301`; mobile deploy `a93c909a` SUCCESS, api/web SKIPPED):
  mobile **Finance Reports** parity, operator, READ-ONLY — the last P10-PAR target. `apps/mobile/lib/api/reports.ts` (`useProfitAndLoss`/`useCashFlow`/`useSalesByCustomer`/
  `useSalesByItem` `{from,to}` + `useArAgingInvoices(intervalDays)` — AR aging is **interval-driven, NOT a date
  range**, mirroring web's `needsDates=false`; queryKey `["reports",<name>,…]`) + `lib/reports-logic.ts` (**pure,
  node-testable**: `REPORT_REGISTRY`/`reportGroups`/`reportMetaById` for the **5 v1 reports** [P&L, Cash Flow, Sales
  by Customer, Sales by Item, AR Aging]; `dateRangeForPreset(preset,today)` presets This-month/Last-month/This-quarter/
  This-year; `arAgingColumns(interval)` whose **keys mirror the server's dynamic bucket naming** `current`/`days1_<i>`/
  `days<i+1>_<2i>`/`days<2i+1>_<3i>`/`days<3i>plus`; `arAgingCustomerRows(buckets)` fold+sort) +
  `app/(operator)/reports/{_layout,index,[report]}.tsx` (index lists reports grouped → `[report]` detail switches on
  id, `SegmentedControl` period[date]/interval[AR aging], KPI cards + label/value tables, **no charts**) + More-hub
  row under INSIGHTS (next to Analytics) + 16 tests. **No money writes** — server-computed values via `fmtCurrency`,
  never derived → no `pricing.ts` risk, no adversarial gate (display surface). Scope v1 = 5 of the web hub's 18
  reports; **charts + the 13-report long tail + CSV export deferred**. Mobile-only ⇒ only `@routeflow/mobile` deploys.
- **P10-PAR-5 COMPLETE + LIVE** (mobile **order-templates / standing-orders** parity, operator): read + act,
  no builder. `apps/mobile/lib/api/order-templates.ts` (`useOrderTemplates` [bare array] / `useOrderTemplate`;
  `useGenerateTemplateOrder` typed `{ id }` → navigate to the created/merged order [web leaves it `unknown`];
  `useUpdateOrderTemplate({id,isActive})` pause/resume; `useDeleteOrderTemplate` hard delete) +
  `lib/order-templates-logic.ts` (`orderTemplatePillFor`/`orderTemplateActionFlags`/`daysLabel` — **ISO 1–7
  Mon..Sun**, guards the Sunday=7 indexing bug in the buyer standing-orders screen) +
  `app/(operator)/order-templates/{_layout,index,[id]}.tsx` (list + detail: Generate now / Pause / Resume /
  Delete) + More-hub row (top of MANAGE) + 9 tests. **No money** (items are `{productId,qty,notes}`, no price).
  Pause AND Resume both work via `PATCH {isActive}` — verified backend (all-optional UpdateDto + `update()`
  maps isActive both ways), so NOT the recurring-resume trap. Create/edit builder + item add/remove deferred.
- **P10-PAR-4 COMPLETE + LIVE** (mobile **payments** parity, operator): cross-invoice payment history —
  `apps/mobile/lib/api/payments.ts` (`useInvoicePayments` list+summary; `usePayment` via the real
  `GET /invoices/payments/:id`; `useVoidPayment`) + `lib/payments-logic.ts` (`paymentMethodPill`/
  `paymentStatusPill`/`paymentActionFlags`) + `app/(operator)/payments/{index,[id]}.tsx` (KPIs +
  receipt detail + Void[gated] + tap-through to invoice) + More-hub row + 15 tests. Standalone
  record/CSV-export deferred. (Flagged a web latent bug: `payments/[id]` `.find` over 200 rows.)
- **Recurring-invoice RESUME FIX + LIVE** (PR #170, user-requested follow-up): added `POST
  /recurring-invoices/:id/activate` + `service.activate()` (the only path that sets `isActive` back to
  true — the PATCH path can't, due to the whitelist ValidationPipe + required DTO fields). Wired the web
  `recurring/page.tsx` resume toggle + **re-enabled mobile Pause/Resume** tiles (`recurringActionFlags`) +
  `recurring-invoices.service.spec` + `recurringInvoice(+Item)` in the prisma-mock. api+web+mobile deployed.
- **P10-PAR-3 COMPLETE + LIVE** (mobile **recurring-invoices** parity, operator): `apps/mobile/lib/api/recurring-invoices.ts`
  (`useRecurringInvoices` [bare array] / `useRecurringInvoice` / `useRun`/`Deactivate`/`ActivateRecurringInvoice`)
  + `lib/recurring-invoices-logic.ts` (`recurringPillFor`/`freqLabel`/`recurringActionFlags`) +
  `app/(operator)/recurring-invoices/{index,[id]}.tsx` (view + Generate-now + Pause/Resume) + More-hub row + 9 tests.
- **P10-PAR-2 COMPLETE + LIVE** (PR #168): mobile **credit-notes** parity
  (operator) — `apps/mobile/lib/api/credit-notes.ts` (read + issue/apply/void; `useOpenInvoicesForCustomer`
  = `GET /invoices?customerId`; apply reads `inv.id`) + `lib/credit-notes-logic.ts` (Apply gated
  ISSUED-only) + `app/(operator)/credit-notes/{index,[id]}.tsx` (detail has an `ApplyInvoicePicker`
  Modal) + More-hub row + 8 tests. Create/issue-builder deferred.
- **P6-2 COMPLETE + LIVE** (PR #167): messaging **send engine + StubProvider**
  on the F0 schema — `apps/api/src/messaging/`. `MessagingService.sendMessage` gates (invoice-policy G12
  → consent → opt-out → contact → quiet-hours) → dispatch via the `MESSAGE_PROVIDER` token → record
  `Message` on the customer `MessageThread` → bump thread → meter WA/SMS (`MeterService` MSGS; failed
  send not recorded/metered). `notify(eventKey)` resolves enabled `NotificationRule`s → renders
  `MessageTemplate` → sends with a fallback chain. StubProvider is the default binding (P6-3/P6-4 swap
  real adapters). Thin operator controller (`POST /messaging/threads/:customerId/messages`, `/notify`,
  `GET /messaging/threads[/:id]`). `messages.findByRun` now scoped to `channel=INTERNAL`. 20 specs. No
  new schema.
- **P10-PAR-1 COMPLETE + LIVE** (PR #165): mobile estimates/quotes parity
  (operator) — `apps/mobile/lib/api/estimates.ts` (mirrors web; read + send/accept/decline/void +
  convert-to-invoice reading `inv.id`) + `lib/estimates-logic.ts` pure helpers (Convert gated
  ACCEPTED-only per server contract) + `app/(operator)/estimates/{index,[id]}.tsx` + More-hub row +
  14 tests. Create/quote-builder deferred. **Deployed via the GitHub flow** (first successful GitHub
  auto-deploy since 07-08 — pipeline confirmed fixed).
- **P6-1 / F0 COMPLETE + LIVE** (PR #163): additive messaging-thread schema
  foundation. `Message` gained `threadId?` + `channel MessageChannel @default(INTERNAL)` (run-chat
  **unregressed** — create/read paths untouched, locked by `apps/api/src/messages/messages.service.spec.ts`);
  6 new tenant-scoped models (`MessageThread`, `MessageTemplate`, `NotificationRule`, `MessageOptOut`,
  `MessagingSettings`, `InboundTriage`) + 5 enums; `Customer` +`smsConsent`/`waConsent`/`consentUpdatedAt`.
  Migration `20260712000000_messaging_threads` applied to prod. Providers/engine/inbox/settings-UI =
  later P6 increments (P6-2…P6-14).
- **P5-01 COMPLETE + LIVE** (PR #159): merchandising promotions + product merch flags, backend + operator
  web UI. Migration `20260711000000_promotions_merch_flags` applied. `/promotions` manager + product merch
  toggles/badges; `GET /buyer/promotions`. Pricing-time application is still **P5-04** (not built). P5-05
  replenishment (#158) also live.
- **✅ RAILWAY DEPLOY PIPELINE FIXED (was "broken" 07-08→07-09).** GitHub deploys had been 404ing at
  "Snapshot code → repository not found" — NOT an App-access loss (Railway's repo picker lists the
  private repo as accessible), but the repo being flipped **private before Railway cloned it**. The fix
  is purely procedural: **stay PUBLIC until the Railway deploy finishes**, per the CLAUDE.md flow. Proven
  by #165 (mobile) deploying via GitHub while public (BUILDING→SUCCESS). #157/#158/#159 were force-shipped
  via `railway up` earlier (still a valid fallback). See memory `project_railway_deploy_outage_2026-07`.

## DO NEXT (in order — one branch/PR per increment)

> **P10-PAR is now fully shipped** (estimates/credit-notes/recurring/payments/order-templates/reports). No more
> mobile parity screens over already-shipped APIs remain. Next mobile deltas (P10) are the ones that mirror
> **unbuilt** P5/P6 web surfaces (buyer portal deltas, messaging inbox) — build the web counterpart first.

1. **P5 Buyer Portal (Lane A)** or resume backend work — the highest-value UNBUILT lane. `docs/design-package/
   PHASE-5-6-10-PLAN.md` §2 has the per-increment table (P5-01 promotions + P5-05 replenishment shipped;
   next unblocked = **P5-04 pricing-time promo application** in `pricing.ts`, and the buyer credits/change-request
   extensions). Pick from the plan by value×(1/risk). Money paths here DO get the adversarial-review + invariant gate.

   **Optional lower-value mobile:** **route-templates** (driver-routing `routes.ts` templates — a SEPARATE feature,
   no items/no order generation; NOT order-templates). Only if a mobile increment is wanted over the buyer work.

2. **P6-3 — real Meta-WhatsApp Cloud + Twilio SMS adapters** behind the `MESSAGE_PROVIDER` token
   (StubProvider stays the default binding; flag/env-gated). **BLOCKED on user-provided provider creds**
   (Meta WA phone-number-id + token; Twilio SID + auth-token) — also needs a MessagingSettings
   provider-creds migration + EncryptionService. Defer until the user supplies creds.

3. **P6-5 — trigger wiring** (domain event → `MessagingService.notify`): needs a real system `User` id
   for `Message.senderId`'s FK (no synthetic id). Then order-status/reminder/expiry events fire notify.

_(P5-01, P5-05, P6-1/F0, P6-2, P10-PAR-1 all DONE + live — see Current state. Full backlog + 18 gating
decisions: `docs/design-package/PHASE-5-6-10-PLAN.md`.)_

## Critical rules

- **Money math only via `pricing.ts`** (3 mirrors: `apps/{api/src/common,web/lib,mobile/lib}`); round every
  write; never re-derive `qty*unitPrice` on boxed lines. Money/compliance paths get an adversarial review +
  invariant gate before deploy.
- **Tenant-scope everything** (`prisma.forTenant()`). **Additive migrations only**, applied to prod MANUALLY
  (never auto-migrate; never `--force-reset`); `git add -f` each new `migration.sql`.
- **Deploy routine = public → merge → private** (standing, pre-approved). If the auto-mode classifier blocks
  `gh repo edit ... --visibility public`, ask the user to run it or add the allow-rule
  `"Bash(gh repo edit najathakram/routeflow --visibility:*)"` to `.claude/settings.local.json`. A fresh
  CI run must be **push-triggered after** the repo is public (a rerun can race the visibility flip).
- **Mobile mirrors web** — never build a mobile screen before its web DTO merges; keep the mobile `pricing.ts`
  mirror in sync in the same PR.
- **Messaging provider (G1) default:** Meta WhatsApp Cloud + Twilio SMS behind a provider-agnostic interface,
  **StubProvider first** — only matters at P6-3/P6-4, not now.

## Maintenance

**At the end of every increment, before you finish, keep the handoff self-contained:**

1. **This doc** — move the completed increment out of _DO NEXT_, update _Current state_ (master tip + what
   shipped / what's built-not-deployed), and bump _Last updated_.
2. **Memory** — update `memory/project_p5_p6_p10_program.md` (mark shipped, refresh the "resume here" branch).
3. **Code map** — surgically update the touched `.claude/code-map/*` entries + bump `_meta.json` (per CLAUDE.md).

Keep entries terse. The goal is that the next session can resume from this file + the plan doc alone.
