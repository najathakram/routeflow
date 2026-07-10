# P5 / P6 / P10 — Session Handoff (Buyer Portal · Messaging · Mobile Deltas)

> **Self-contained resume doc for the P5/P6/P10 build program.** A new session (even a
> different Claude profile without this project's auto-memory) can start from this file alone.
> **Keep it current — see [§ Maintenance](#maintenance) at the bottom. Update it at the end of
> every increment before you finish.**
>
> **Last updated:** 2026-07-09 — P10-PAR-4 mobile payments COMPLETE + LIVE; recurring-invoice resume FIX
> (#170), P10-PAR-3, P10-PAR-2 (#168), P6-2 (#167), P10-PAR-1 (#165), P6-1/F0 (#163), P5-01 (#159) live.
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

1. **More P10-PAR mobile parity screens** over already-shipped web APIs (next: route-templates → reports;
   estimates + credit-notes + recurring-invoices + payments DONE) — same proven pattern as P10-PAR-1..4:
   mirror the web `lib/api/*` hooks + list/detail screens under `app/(operator)/…` + a More-hub row,
   pure-logic Jest only, no new models. LOW risk — the default for unattended runs. **Ship only working
   actions** (see the recurring-invoices resume bug — don't ship a broken/trap action; defer + spawn a task).
   NOTE: reports is viz-heavy (web uses recharts; mobile has no chart kit) — scope to summary tables/cards.

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
