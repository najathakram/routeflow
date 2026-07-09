# P5 / P6 / P10 — Session Handoff (Buyer Portal · Messaging · Mobile Deltas)

> **Self-contained resume doc for the P5/P6/P10 build program.** A new session (even a
> different Claude profile without this project's auto-memory) can start from this file alone.
> **Keep it current — see [§ Maintenance](#maintenance) at the bottom. Update it at the end of
> every increment before you finish.**
>
> **Last updated:** 2026-07-09 — P5-05 shipped; P5-01 backend built (not deployed).

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

- **master @ 65cab27.** P5-05 (buyer replenishment estimates, `GET /buyer/replenishment`) is **SHIPPED + live**.
- **P5-01 BACKEND built, NOT deployed** — branch `feat/promotions-merch-flags` (commit `ea499d5`, pushed).
  Contains: additive migration `20260711000000_promotions_merch_flags` (`Product.isNew/isDeal` +
  `Promotion`/`PromotionProduct`), `apps/api/src/promotions/*` (CRUD `@Roles(OPERATOR)` + `activeForCatalog`),
  `UpdateProductDto` merch flags, `GET /buyer/promotions`, specs (verify was 18/18). Prisma client regenerated.

## DO NEXT (in order — one branch/PR per increment)

1. **Finish + deploy P5-01.** On `feat/promotions-merch-flags`: add the operator web UI (apps/web Products
   surface) to manage promotions + toggle product featured/new/deal flags via the existing endpoints. (Do NOT
   fold in pricing-time promo application — that's a separate increment, **P5-04**.) Then deploy the whole
   increment: **MIGRATE PROD FIRST** (`railway run --service postgres node apps/api/scripts/prod-migrate.mjs`
   from a tree that has the migration) → public → CI green → merge → private → `post-deploy-check`. Migration
   must precede the app deploy.

2. **P6-1 / F0 — messaging thread schema.** G3 default = **generalize run-chat `Message` ADDITIVELY**: add
   nullable `threadId` + `channel`(=`INTERNAL` default) columns + NEW models (`MessageThread`,
   `MessageTemplate`, `NotificationRule`, `MessageOptOut`, `MessagingSettings`, `InboundTriage`) + `Customer`
   consent columns. **Do NOT rename the `Message` table** — the existing driver run-chat must keep working;
   verify it is unregressed. Additive migration; `git add -f` the migration.sql.

3. **P10-PAR-1 — mobile estimates/quotes parity screen** (apps/mobile), mirroring the shipped web estimates
   API. No new models. Mobile Jest = pure-logic only.

_(Full backlog + dependencies + 18 gating decisions: `docs/design-package/PHASE-5-6-10-PLAN.md`.)_

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
