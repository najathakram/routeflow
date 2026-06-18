# /new-feature — introduce a feature the RouteFlow way

A feature is not done until it has tests, passing `check-types` + `lint`, a migration
(if it touches the DB), and a Conventional-Commit PR. Enforce this sequence — do not reorder.

## Confirm before writing any code

1. Feature name (slug, e.g. `invoice-export`)
2. One-sentence user-facing description
3. What it explicitly does NOT do
4. ≥ 3 testable acceptance criteria
5. Touches the **database**? (Prisma migration needed?)
6. Adds/changes **API** routes? (which tenant/role guards?)
7. Adds/changes **web** and/or **mobile** UI?

If any answer is missing, ask first. Remember: **web is the golden reference** — mobile mirrors
its endpoints/DTOs/flows.

## Step 1 — Branch

```bash
git checkout -b feat/<slug>
```

## Step 2 — Failing tests first (Red)

Write tests in the affected workspace(s):

- **API** → `apps/api/src/<feature>/<feature>.service.spec.ts` (NestJS `Test.createTestingModule`, mock Prisma at the boundary, assert **tenant isolation** and role guards).
- **Web** → `apps/web/e2e/<feature>.spec.ts` (Playwright; reuse role auth storage-state).
- **Mobile** → `apps/mobile/__tests__/<feature>.test.ts` (pure-logic Jest only).

Run them and confirm they fail for the right reason (missing impl, not a typo):

```bash
npm run test            # turbo → Jest (api, mobile)
npm run test:e2e        # turbo → Playwright (web), if UI
```

Commit the red tests: `git commit -m "test(<slug>): failing tests for <feature>"`

## Step 3 — Prisma migration (only if DB change)

Follow `CLAUDE_SESSION_PREAMBLE.md`. Local only:

```bash
npm run db:up
cd apps/api && npx prisma migrate dev --name <slug>
```

**Never** `--force-reset`. **Never** auto-deploy. Prod migration is a deploy-time concern
(`railway run npx prisma migrate deploy`), not part of this branch.

## Step 4 — Implement minimally (Green)

NestJS scaffold order: `*.module.ts` → `*.controller.ts` (guards + `class-validator` DTOs) →
`*.service.ts`. Stop as soon as tests pass — no gold-plating.

## Step 5 — Refactor + full local gate

```bash
npm run check-types     # tsc per workspace (Prisma client must be generated)
npm run lint            # eslint per workspace
npm run test            # + npm run test:e2e if web changed
```

All green. Fix failures — never skip tests. Update the relevant `.env.example` if you added vars.

## Step 6 — Commit + PR

```bash
git commit -m "feat(<slug>): <imperative subject ≤72 chars>"
git push origin feat/<slug>
```

PR body: Summary · Acceptance criteria (checked) · Tests added · DB migration (file or "none") ·
Breaking changes. Do not merge until CI is green.
