# P5 / P6 / P10 — Session Handoff (Buyer Portal · Messaging · Mobile Deltas)

> **Self-contained resume doc for the P5/P6/P10 build program.** A new session (even a
> different Claude profile without this project's auto-memory) can start from this file alone.
> **Keep it current — see [§ Maintenance](#maintenance) at the bottom. Update it at the end of
> every increment before you finish.**
>
> **Last updated:** 2026-07-09 — P6-1/F0 messaging-thread schema COMPLETE + LIVE (PR #163). P5-01 also
> live (#159). ⚠️ Railway GitHub auto-deploys still broken since 07-08 (root cause: App can't clone the
> private repo — "Snapshot code → repository not found"). Ship with `railway up` until the user reinstalls
> the Railway GitHub App. Canonical flow now in CLAUDE.md: **public → merge → deploy (wait) → private.**

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

- **master @ 66d550d.** **P6-1 / F0 COMPLETE + LIVE** (PR #163): additive messaging-thread schema
  foundation. `Message` gained `threadId?` + `channel MessageChannel @default(INTERNAL)` (run-chat
  **unregressed** — create/read paths untouched, locked by `apps/api/src/messages/messages.service.spec.ts`);
  6 new tenant-scoped models (`MessageThread`, `MessageTemplate`, `NotificationRule`, `MessageOptOut`,
  `MessagingSettings`, `InboundTriage`) + 5 enums; `Customer` +`smsConsent`/`waConsent`/`consentUpdatedAt`.
  Migration `20260712000000_messaging_threads` applied to prod; deployed via `railway up` (GitHub deploy
  still broken). Providers/engine/inbox/settings-UI = later P6 increments (P6-2…P6-14).
- **P5-01 COMPLETE + LIVE** (PR #159): merchandising promotions + product merch flags, backend + operator
  web UI. Migration `20260711000000_promotions_merch_flags` applied. `/promotions` manager + product merch
  toggles/badges; `GET /buyer/promotions`. Pricing-time application is still **P5-04** (not built). P5-05
  replenishment (#158) also live.
- **⚠️ RAILWAY GITHUB AUTO-DEPLOYS BROKEN SINCE 2026-07-08 — ROOT CAUSE CONFIRMED (Railway dashboard).**
  Every GitHub-triggered deploy (web + api) FAILS at **"Initialization › Snapshot code" with
  `##NOT-FOUND## repository not found`** — build/deploy never start. Railway **cannot clone the repo**:
  it's private (RouteFlow flips public only briefly for CI, then back to private right after merge) and
  **Railway's GitHub App no longer has access to `najathakram/routeflow`**. Source connection config is
  intact (repo/branch/auto-deploy all set); it's purely a repo-access problem. Not code — failures
  predate P5-01 and line up with #157/#158/#159 merges. Account tangle to know: repo owner = `najathakram`
  (gh CLI), a *different* GitHub account `najathakram91` is logged into the browser, Railway =
  `najathakram1@gmail.com`.
  - **PROVEN workaround (used for P5-01):** `railway up --service @routeflow/api --ci` then
    `--service @routeflow/web --ci` — force-deploys local source, bypasses the GitHub clone. Succeeds.
    Then run `post-deploy-check`. Prod DB is fully migrated.
  - **Permanent fix (user action — I can't grant App access):** reinstall/grant the **Railway GitHub App**
    access to `najathakram/routeflow` on the owner account (Railway → each service → Settings → Source →
    edit/reconnect repo, OR github.com/apps/railway → Configure → add repo). Then GitHub deploys clone the
    private repo fine. Alternatives: keep the repo PUBLIC until Railway finishes each deploy, or make it
    permanently public (exposes source). See memory `project_railway_deploy_outage_2026-07`.

## DO NEXT (in order — one branch/PR per increment)

1. **P10-PAR-1 — mobile estimates/quotes parity screen** (apps/mobile), mirroring the shipped web estimates
   API. No new models. Mobile Jest = pure-logic only.

2. **P6-2 — messaging engine + StubProvider** (next P6 step now that F0 schema is live): the
   provider-agnostic `MessageProvider` interface + `StubProvider` (logs, no send), a message service that
   writes `Message` rows on a `MessageThread` with `channel`, resolves templates (`MessageTemplate`), honors
   `NotificationRule`/`MessageOptOut`/quiet-hours (`MessagingSettings`). Real Meta-WA/Twilio adapters are
   later (P6-3/P6-4). Everything tenant-scoped; no money.

_(P6-1/F0 schema foundation is DONE — see Current state. Full backlog + dependencies + 18 gating
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
