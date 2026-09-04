---
name: rebuild
description: >
  RouteFlow rebuild routine — execute this EVERY TIME the user asks to rebuild, build,
  deploy, merge, "commit and build", or push to Railway. Auto-load on: "rebuild",
  "build", "deploy", "push to railway", "merge the PR", "commit and build", "release",
  "ship it", "make it live".
---

# Skill: RouteFlow Rebuild Routine

> **Test-tenant policy**: any tenant a test/seed/QA run touches MUST satisfy
> `scripts/lib/test-tenants.cjs` (`test`, `e2e-routeflow`, or `qa-*`/`e2e-*`/`ux-audit-*`).
> Never target a live client tenant — see CLAUDE.md "Test tenants & real-client data".

**MANDATORY — run ALL 3 steps in order every time the user asks to rebuild/deploy**, including
Step 2's public/private visibility flip **while private-minute Actions billing is broken** (see
[`docs/runbooks/deploy-visibility-flip.md`](../../../docs/runbooks/deploy-visibility-flip.md) —
its retirement checklist governs when Step 2 stops needing the flip; nothing else in this skill
changes when it does).

This is a standing behavioral instruction. Never skip steps or reorder them.

---

## Step 1 — Run regression + smoke gates (Layer 1)

Before touching GitHub, confirm the working tree is clean and all tests pass:

```bash
npm run verify
```

If `verify` fails → stop, fix the failures, then restart from Step 1.

---

## Step 1.5 — GATE: apply any pending PROD migration BEFORE the merge ⚠️

Merging to master auto-redeploys the app via Railway, and **Railway never runs
migrations** (`CMD = node dist/main.js` only). If the branch adds a Prisma migration,
the freshly-deployed image will hit **missing columns and 500** until the migration
lands — so the migration must be applied to **prod first**.

```bash
# Does this branch add a migration not yet on master?
git diff --name-only origin/master...HEAD -- apps/api/prisma/migrations/
```

If it lists a new migration → it must be applied to prod (human-run, after review — see
the **db-migration** skill + `CLAUDE_SESSION_PREAMBLE.md`) **before** the Step 2 merge.
Additive-only migrations make this ordering safe: the old image tolerates the new columns,
and the new image needs them. Do not merge until the migration shows as applied.

---

## Step 2 — Make repo public, merge PR, make repo private

While private-minute Actions billing is unbilled-broken (see the runbook linked above), a private
run dies as a 0-step failure, so CI needs the public window below.

```bash
# 0. Start the visibility watchdog detached FIRST (45 min) — see
#    docs/runbooks/deploy-visibility-flip.md "Watchdog (mandatory)". It flips the repo
#    private on its own deadline even if this session dies mid-window.
#    Windows: Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "scripts/visibility-watchdog.mjs","--minutes","45"
#    POSIX:   nohup node scripts/visibility-watchdog.mjs --minutes 45 >/dev/null 2>&1 &

# 1. Make public
gh repo edit najathakram/routeflow --visibility public --accept-visibility-change-consequences

# 2. Find the open PR on the current branch (or pass the PR number explicitly)
gh pr list --state open --json number,headRefName

# 3. Squash-merge the PR to master
gh pr merge <PR_NUMBER> --squash --auto --delete-branch

# 4. Wait for CI to pass (GitHub Actions — lint + type-check + test)
gh run watch          # or: gh pr checks <PR_NUMBER> --watch

# 5. Wait until the Railway deploy reaches BUILDING — never flip during INITIALIZING, which IS
#    the snapshot-clone window (flipping there caused five failed deploys). Full writeup:
#    docs/runbooks/deploy-visibility-flip.md
until railway deployment list --service @routeflow/api | sed -n '2p' | grep -qE 'BUILDING|DEPLOYING|SUCCESS'; do sleep 10; done

# 6. THEN make private again — as a `finally`, even if CI failed or the merge was aborted
gh repo edit najathakram/routeflow --visibility private --accept-visibility-change-consequences
```

**Never leave the repo public.** Step 6 must run even if CI fails, and must wait for `BUILDING`
first — put both in a finally block in your mental model; see the runbook linked above for the
failure modes this guards against and the retirement checklist.

Railway deploys automatically from master after the merge.

---

## Step 3 — Post-deploy Layer 2 smoke check

After Railway finishes deploying (health check passes), run the authenticated smoke probe:

```bash
SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app \
SMOKE_TENANT_SLUG=e2e-routeflow \
npm run post-deploy-check
```

To poll until Railway is healthy before probing:

```bash
SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app \
SMOKE_TENANT_SLUG=e2e-routeflow \
SMOKE_WAIT_RETRIES=30 \
npm run post-deploy-check
```

If the smoke probe passes → deploy is verified. Report the result to the user.

---

## Quick reference

| Step | What                    | Command                                                                                                                                                                                                          |
| ---- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Gate                    | `npm run verify`                                                                                                                                                                                                 |
| 2    | Visibility flip + merge | public → merge PR → wait for `BUILDING` → private — see [`docs/runbooks/deploy-visibility-flip.md`](../../../docs/runbooks/deploy-visibility-flip.md) for the rationale, failure modes, and retirement checklist |
| 3    | Smoke                   | `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app SMOKE_TENANT_SLUG=e2e-routeflow npm run post-deploy-check`                                                                                        |

Railway webhook → `post-deploy.yml` → Playwright e2e runs automatically after deploy.
See `.github/workflows/post-deploy.yml` for the webhook setup.
