# P5 / P6 / P10 — Session Handoff (Buyer Portal · Messaging · Mobile Deltas)

> **Self-contained resume doc for the P5/P6/P10 build program.** A new session (even a
> different Claude profile without this project's auto-memory) can start from this file alone.
> **Keep it current — see [§ Maintenance](#maintenance) at the bottom. Update it at the end of
> every increment before you finish.**
>
> **Last updated:** 2026-07-09 — P10-PAR-1 mobile estimates parity COMPLETE + LIVE (PR #165); P6-1/F0
> (#163) + P5-01 (#159) live. ✅ **Railway GitHub auto-deploys FIXED** — the failures were flipping the
> repo private before Railway cloned it; #165 deployed via GitHub while public. Follow the canonical
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

- **master @ 0171ddd.** **P10-PAR-1 COMPLETE + LIVE** (PR #165): mobile estimates/quotes parity
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

1. **P6-2 — messaging engine + StubProvider** (next P6 step now that F0 schema is live): the
   provider-agnostic `MessageProvider` interface + `StubProvider` (logs, no send), a message service that
   writes `Message` rows on a `MessageThread` with `channel`, resolves templates (`MessageTemplate`), honors
   `NotificationRule`/`MessageOptOut`/quiet-hours (`MessagingSettings`). Real Meta-WA/Twilio adapters are
   later (P6-3/P6-4). Everything tenant-scoped; no money.

2. **More P10-PAR mobile parity screens** over already-shipped web APIs (credit-notes, reports, recurring
   invoices, route-templates, payments) — same pattern as P10-PAR-1 (mirror web hooks + list/detail,
   pure-logic Jest only, no new models).

_(P5-01, P5-05, P6-1/F0, P10-PAR-1 all DONE + live — see Current state. Full backlog + dependencies + 18
gating decisions: `docs/design-package/PHASE-5-6-10-PLAN.md`.)_

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
