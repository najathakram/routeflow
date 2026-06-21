---
name: rebuild
description: >
  RouteFlow rebuild routine — execute this EVERY TIME the user asks to rebuild, build,
  deploy, merge, "commit and build", or push to Railway. Auto-load on: "rebuild",
  "build", "deploy", "push to railway", "merge the PR", "commit and build", "release",
  "ship it", "make it live".
---

# Skill: RouteFlow Rebuild Routine

**MANDATORY — run ALL 3 steps in order every time the user asks to rebuild/deploy.**

This is a standing behavioral instruction. Never skip steps or reorder them.

---

## Step 1 — Run regression + smoke gates (Layer 1)

Before touching GitHub, confirm the working tree is clean and all tests pass:

```bash
npm run verify
```

If `verify` fails → stop, fix the failures, then restart from Step 1.

---

## Step 2 — Make repo public, merge PR, make repo private

RouteFlow uses a $0 GitHub Actions budget; CI only runs on public repos.

```bash
# 1. Make public
gh repo edit najathakram/routeflow --visibility public --yes

# 2. Find the open PR on the current branch (or pass the PR number explicitly)
gh pr list --state open --json number,headRefName

# 3. Squash-merge the PR to master
gh pr merge <PR_NUMBER> --squash --auto --delete-branch

# 4. Wait for CI to pass (GitHub Actions — lint + type-check + test + e2e)
gh run watch          # or: gh pr checks <PR_NUMBER> --watch

# 5. Make private again (ALWAYS do this, even if CI fails)
gh repo edit najathakram/routeflow --visibility private --yes
```

**Never leave the repo public.** Step 5 must run even if CI fails — put it in a finally block in your mental model.

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

| Step | What    | Command                                        |
| ---- | ------- | ---------------------------------------------- |
| 0    | Gate    | `npm run verify`                               |
| 1    | Public  | `gh repo edit ... --visibility public`         |
| 2    | Merge   | `gh pr merge <N> --squash --auto`              |
| 3    | Wait CI | `gh run watch`                                 |
| 4    | Private | `gh repo edit ... --visibility private`        |
| 5    | Smoke   | `SMOKE_BASE_URL=... npm run post-deploy-check` |

Railway webhook → `post-deploy.yml` → Playwright e2e runs automatically after deploy.
See `.github/workflows/post-deploy.yml` for the webhook setup.
