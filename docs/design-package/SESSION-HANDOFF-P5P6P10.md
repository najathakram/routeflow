# P5 / P6 / P10 — Session Handoff (Buyer Portal · Messaging · Mobile Deltas)

> **Self-contained resume doc for the P5/P6/P10 build program.** A new session (even a
> different Claude profile without this project's auto-memory) can start from this file alone.
> **Keep it current — see [§ Maintenance](#maintenance) at the bottom. Update it at the end of
> every increment before you finish.**
>
> **Last updated:** 2026-07-09 — P10-PAR-5 mobile order-templates (standing orders) COMPLETE + LIVE (#173).
> **Handoff made cold-start-ready:** the next increment (**P10-PAR-6 reports**) DO-NEXT now carries the full
> scouted surface (endpoints, files, viz/money constraints, scope decision) so a fresh session can start from
> this doc alone. Prior: P10-PAR-4 payments (#172), recurring resume FIX (#170), P10-PAR-3, P10-PAR-2 (#168),
> P6-2 (#167), P10-PAR-1 (#165), P6-1/F0 (#163), P5-01 (#159) live.
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

1. **P10-PAR-6 — mobile `reports` (Finance Reports) parity** — the last P10-PAR target and a good spot to
   pause + consolidate. **This one needs a short design pass FIRST** (it's a big hub, not a 1:1 copy). Scouted
   facts so a cold session can start immediately:
   - **What it is:** the web **Finance Reports** hub — `apps/web/app/(dashboard)/finance/reports/page.tsx`
     (the golden reference) driven by report hooks in **`apps/web/lib/api/finance.ts`**. NOT the same as the
     `/analytics/*` set — mobile **already has** `app/(operator)/analytics/index.tsx` (top products/customers,
     DSO, AOV via `lib/api/analytics.ts`). Reports is genuinely new; don't duplicate analytics.
   - **Endpoints (all served by `apps/api/src/bookkeeping/bookkeeping.controller.ts`, ~30 `@Get`):**
     `GET /bookkeeping/reports/{pl, sales-by-customer, sales-by-item, sales-by-driver, ar-aging-details,
     ar-aging-invoices, bad-debts, cashflow, customer-balance, expense-details, expenses-by-category,
     expenses-by-customer, invoice-details, payments-received, receivable-summary, refund-history,
     time-to-get-paid, estimate-details}` — every one takes a **`{ from, to }` date-range** query param;
     web queryKey is `["reports", <name>, from, to]`. Mirror the exact URLs from `finance.ts` (authoritative).
   - **Mobile viz constraint:** NO chart kit installed. `react-native-svg` **15.15.3 IS** present (charts
     *could* be hand-rolled) but **scope v1 to summary cards + tables, no charts** — the data is already
     mostly tabular (Sales Amount, Qty Sold, counts, Net/Gross Profit, Cash In/Out), so tables lose little.
   - **Money:** READ-ONLY & **server-computed** (P&L, sales amounts, AR aging, cash flow). Display via
     `fmtCurrency`; **never derive** a total client-side. No money *writes* → no `pricing.ts` write-path risk,
     so no adversarial-review gate; it's a display surface. Round-trip is just render-what-the-server-returns.
   - **SCOPE (the design decision to make first):** 18 reports is too much for one screen. Pick a high-value
     **subset for v1** (suggest: P&L, Sales by Customer, Sales by Item, AR Aging, Cash Flow) behind a
     **date-range picker** (default e.g. this-month), and defer the long tail. Shape: a `reports` index that
     lists the available reports → a detail/section screen per report (or one screen with a report picker +
     date range). No per-row actions (pure reporting) → simpler than the prior parity screens.
   - **Files (same 6-file pattern):** `apps/mobile/lib/api/reports.ts` (mirror the `finance.ts` report hooks —
     bare `.then(r => r.data)`, `{from,to}` params), `lib/reports-logic.ts` (date-range presets + row/section
     shaping + a report registry; pure, node-Jest-lockable — NO screen imports), `app/(operator)/reports/
     {_layout,index,[report].tsx or sectioned index}.tsx`, `__tests__/reports-helpers.test.ts`, and a
     **More-hub row under the INSIGHTS group** (next to Analytics, `more.tsx` ~line 182). No new models.
   - Cadence: `npm run verify` (typecheck+lint+pure-logic Jest) → deploy via the canonical
     **public → merge → deploy(WAIT, still public) → private** flow (mobile-only ⇒ only `@routeflow/mobile`
     deploys; api/web SKIP). Then update this doc + memory + code map.

   **Also available (lower priority):** **route-templates** (driver-routing `routes.ts` templates) — a SEPARATE,
   lower-value feature (no items / no order generation), optional; NOT the order-templates screen just shipped.

   General rule for all P10-PAR: mirror the web `lib/api/*` hooks + screens under `app/(operator)/…` + a
   More-hub row, pure-logic Jest only, no new models. **Ship only working actions** — verify each mutation's
   server path against the backend before wiring it (the recurring-resume bug); defer + spawn a task for any
   broken/trap action.

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
