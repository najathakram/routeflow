# RouteFlow CRM — cloud session brief (from the lead, 2026-09-15)

You are the **RouteFlow CRM** session, running in the cloud. The lead is the RouteFlow lead session on the owner's machine. You cannot message the lead, so this file and the two files below are the channel.

## Read first
1. `CLAUDE.md` (repo root) and `CONTEXT.md`.
2. `.claude/code-map/INDEX.md`, then only the area files you need.
3. `.claude/lessons/LESSONS-DIGEST.md`.
4. This folder: `plan.md` (Fable plan with owner rulings appended), `context-pack.md` (Frappe CRM inventory), and `spec-leads-deals.md` when it lands (a follow-up commit on this branch; `git pull` for it).

## Binding owner rulings
- **Behaviour translation from Frappe CRM source** into RouteFlow's stack (NestJS 11 + Prisma 7/Postgres API, Next.js 14 web with Radix + Tailwind, Expo mobile). The owner covers licensing. Translate behaviour, data model and rules; never copy Frappe's look.
- **RouteFlow's design system is binding.** Reuse existing web/mobile components, colours, fonts and layout. There must be no visible style change to RouteFlow.
- **Playwright proof for every web UI change**: screenshots at 1440, 768 and 390 wide, every state (empty, loading, error, populated), side by side with a neighbouring existing screen, plus an independent visual review. Native mobile = Jest tests + design review, stated honestly.
- **Sonnet builds, Opus reviews, Fable decides.** Fable never writes code.
- A CRM module already exists (GoHighLevel integration, dark gate). Build on the code map's crm entries; do not collide with it. Lesson L-113: a new Nest module must import the modules its providers need, or the API crashes at boot.

## Scope now
Phase 1 exactly as defined in `plan.md`. Start with its S0 on a fresh branch cut from this one (`feat/crm-phase1-<slice>`). Keep each PR small enough to review in one sitting.

## Engine
This branch carries the fixed dev-pipeline engine (sha256 `b71f6c8e2a4a4c93fe937e76b7d72d56b3f429a10d49c23aecefe32d7693e789`, 212,738 B). Verify the sha before any launch. If the Workflow tool is not available in your environment, follow `.claude/skills/dev-pipeline/SKILL.md` by hand with subagents and say so in STATUS.md.

## Hard rules
- Never merge a PR, never change repo visibility, never push to `master`, never force-push without the lead's written OK in `LEAD-REPLIES.md`.
- Merge `origin/master` into your branch before every push. Never rebase a pushed branch.
- `SKIP_VERIFY` only for docs-only pushes. Code pushes run the full `npm run verify`.
- Never touch production: no Railway commands, no prod database, no prod URLs in code.
- Test tenants only: `test`, `e2e-routeflow`, `routeflow-demo`, `qa-*`, `e2e-*`, `ux-audit-*`. Never reference a live client name, slug or tenant id anywhere; use `acme`-style placeholders.
- Prisma schema is a folder (`apps/api/prisma/schema/`); add models to the right domain file and to `MODEL_DOMAIN` in `apps/api/scripts/split-prisma-schema.mjs`. Migrations are additive only; the owner applies them to prod.
- New entitlement gates ship dark (`addon-gate-registry.ts` / `DARK_PLAN_FLAGS`). A feature-grants redesign is planned; register the CRM gate the existing way and note it in STATUS.md.
- Bug ids and lesson ids come only from the lead. Ask in LEAD-REQUESTS.md; never mint.
- Code map and lessons updates land in the same PR as the code.
- If Docker/compose or Playwright cannot run in your environment, build and unit-test anyway, then stop before the compose boot gate and the UI proof and say so in STATUS.md. The lead runs those locally.

## Reporting (the lead reads these on every check)
- `STATUS.md` in this folder: after each step, overwrite with date/time UTC, branch + head sha, step done, next step, blockers. Commit and push it.
- `LEAD-REQUESTS.md`: append a dated question or request (ids, a force-push, a ruling). Push it, then keep working on anything that does not depend on the answer.
- `LEAD-REPLIES.md`: the lead writes answers here on this branch. `git pull` before each step.
- When a PR is ready: open it as a draft against `master`, put its number in STATUS.md, and stop that slice. The lead reviews and merges in a public CI window.
