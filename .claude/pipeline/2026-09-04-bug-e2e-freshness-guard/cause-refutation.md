# Cause refutation — `e2e` "Skip superseded deployments" always skips

Bug-pipeline S2. Read-only. Adversarial: each half of the suspected cause was assumed wrong and
attacked. Workflow read from `origin/master` (`git show origin/master:.github/workflows/ci.yml`,
saved at `<scratchpad>/bug-e2e-freshness-guard/ci-master.yml`, 656 lines — line numbers below are
that file's and match the brief). Raw probe output: `probe1..21.txt`, `docs5..7.txt` in the same
folder.

---

## VERDICTS (up front)

| Half                | Claim                                                                                                                                                                            | Verdict                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1**               | `gh api` on a 4xx writes the error JSON to **stdout**, exits 1, `--jq` is not applied, `\|\| true` masks the exit, `$latest` is non-empty, the compare always yields `run=false` | **CONFIRMED** — every clause reproduced locally. Diverging lines: **402** (capture) and **403** (`[ -z "$latest" ]` is false, so the fail-open branch at 404–406 is never taken); the wrong output is written at **413**.                                                                                                                                                                                          |
| **2**               | A `default_workflow_permissions: read` token 403s on `GET /repos/{o}/{r}/deployments`                                                                                            | **CONFIRMED as a fact, and the mechanism is candidate (d)** — GitHub's "restricted" default grants read on **`contents` and `packages` only**; `deployments` is `none`. **Candidate (b) is the trigger**: the call only _started_ failing once the E2E job began running after the private flip, because on a **public** repo the deployments list is public data any token can read. **(a) and (c) are REFUTED.** |
| **Brief's premise** | "every `deployment_status` E2E run has been skipped since 2026-09-02T15:19"                                                                                                      | **REFUTED.** The guard worked correctly through **2026-09-03T06:00:52Z** (it printed real 40-char SHAs, and even produced one _correct_ skip). The first 403 was **2026-09-03T12:33:55Z**. Exactly **two** merges lost E2E coverage, not "every run since 09-02".                                                                                                                                                  |

---

## Half 1 — `gh api` stdout/exit behaviour

### Probe (this machine, `gh` 2.87.3, user OAuth token — `probe1.txt`, `probe2.txt`)

```
$ gh api repos/najathakram/routeflow/nonexistent-endpoint --jq '.x' 1>/tmp/gh.out 2>/tmp/gh.err
EXIT=1
--- stdout ---
{
  "message": "Not Found",
  "documentation_url": "https://docs.github.com/rest",
  "status": "404"
}[end stdout]
--- stderr ---
gh: Not Found (HTTP 404)
[end stderr]
```

Captured exactly as the guard captures it (line 402's shape):

```
$ latest=$(gh api repos/najathakram/routeflow/nonexistent-endpoint --jq '.x' 2>/dev/null || true)
CAPTURED=[{
  "message": "Not Found",
  "documentation_url": "https://docs.github.com/rest",
  "status": "404"
}]
BRANCH=compare (non-empty)
```

A **real 403** (an org endpoint this token cannot read) reproduces the CI log's _exact single-line_
shape, confirming the CI string is `gh api`'s stdout and nothing else:

```
$ gh api "orgs/github/actions/permissions" --jq '.enabled_repositories' 2>/dev/null; echo EXIT=$?
{"message":"You must be an org admin or have the actions policies fine-grained permission.","documentation_url":"https://docs.github.com/rest/actions/permissions#get-github-actions-permissions-for-an-organization","status":"403"}EXIT=1
```

**`--jq` is NOT applied to an error body** — disproved the "maybe jq ran and returned the object"
alternative by asking for a field that exists in the error body:

```
$ gh api repos/najathakram/routeflow/nonexistent-endpoint --jq '.message' 2>/dev/null
{ "message": "Not Found", "documentation_url": "...", "status": "404" }      # NOT "Not Found"
```

Identical output with and without `--jq` (`probe1.txt` C vs A). So the filter is bypassed entirely
on non-2xx; `gh` dumps the raw body.

### Two counter-hypotheses I tried and had to discard

- _"On a success with no deployments, `.[0].sha` yields the string `null`, so the guard would skip
  even on a 200."_ — **Refuted.** `gh api "repos/github/gitignore/deployments?per_page=1" --jq
'.[0].sha'` (0 deployments) captures the **empty string**, len 0 (`probe21.txt`). The fail-open at
  403–407 does fire correctly for an empty result. `// empty` would be belt-and-braces only.
- _"`set -uo pipefail` at 387 already aborts the step."_ — **Refuted.** There is no pipe on 402 and
  `set -e` (which GitHub's default `bash --noprofile --norc -eo pipefail {0}` does supply) is
  explicitly neutralised for this statement by `|| true`. Nothing fails.

### The diverging lines

```
402:  latest=$(gh api "repos/$GITHUB_REPOSITORY/deployments?per_page=1" --jq '.[0].sha' 2>/dev/null || true)
403:  if [ -z "$latest" ]; then          # <-- false: $latest holds the 403 JSON body
409:  if [ "$DEPLOY_SHA" = "$latest" ]; then
413:    echo "run=false" >> "$GITHUB_OUTPUT"
```

Line 402 conflates three distinguishable outcomes into one string: _success with a SHA_, _success
with no deployments_, and _HTTP error_. `2>/dev/null` throws away the only signal that separates the
third (`gh: … (HTTP 403)` on stderr), and `|| true` throws away the second (`$?`). Line 403 then
tests the wrong thing — emptiness, not success. **The fail-open the author wrote (404–406) is
unreachable for the failure mode it was written for.**

---

## Half 2 — why a read-default token 403s on `deployments`

### The four candidates, ruled on

**(d) — the restricted default set does not include `deployments`. CONFIRMED; this is the
mechanism.** GitHub's own docs source, `github/docs`
`data/reusables/actions/workflows/github-token-access.md`, verbatim (`docs5.txt`):

> "Under "Workflow permissions", choose whether you want the `GITHUB_TOKEN` to have read and write
> access for all permissions (the permissive setting), or just read access for the `contents` and
> `packages` permissions (the restricted setting)."

`gh api repos/najathakram/routeflow/actions/permissions/workflow` →
`{"default_workflow_permissions":"read", …}` = the restricted setting = `contents: read`,
`packages: read` (plus the always-granted `metadata: read`). **`deployments` is `none`.** With no
`permissions:` block anywhere in `ci.yml` (one match in the whole file, at line 310, inside a
comment), the guard's token has never had `deployments: read`.

**(b) — the repo was PRIVATE when the job ran. CONFIRMED as the trigger.** With `deployments: none`
constant, visibility is the only variable that can turn a 200 into a 403, and it does, because on a
public repo the deployments list is _public data_ — readable with **no token at all**
(`probe7.txt`):

```
vercel/next.js deployments:      200   (unauthenticated)
actions/checkout deployments:    200   (unauthenticated)
najathakram/routeflow (private): 404   (unauthenticated)
```

The dated timeline matches exactly (`probe12.txt`, `probe20.txt`, `HANDOFF.md:96`,
`local-assets/handoff/2026-09-03/artifacts/improvements-program.html:310`):

| Deployment (UTC)           | E2E guard ran                         | Guard result                       | Public window                           |
| -------------------------- | ------------------------------------- | ---------------------------------- | --------------------------------------- |
| 09-01T19:48 `8a51790d`     | 19:51:29                              | real SHA — ran                     | (long window)                           |
| 09-02T02:51 `39632d27`     | 02:53:41                              | real SHA — ran                     |                                         |
| 09-02T09:10 `24421170`     | 09:13:11                              | real SHA — ran                     |                                         |
| 09-02T15:19 `d4f85fd2`     | 15:21:00                              | real SHA — ran                     |                                         |
| 09-03T04:30 `d0769701`     | 04:33:50                              | real SHA — ran                     |                                         |
| 09-03T05:58 `97de93e1`     | 06:00:46                              | real SHA — ran                     |                                         |
| 09-03T05:58 `97de93e1`     | 06:00:52 (stale event for `d0769701`) | **correct skip, real SHA printed** |                                         |
| **09-03T12:30 `e39bf9db`** | **12:33:55**                          | **403 body**                       | **12:22–12:32Z** (flip 1.5 min earlier) |
| **09-04T14:41 `f60bd27c`** | **14:45:02**                          | **403 body**                       | **14:33–14:42Z** (flip 2.5 min earlier) |

Both failures ran **after** a recorded flip-to-private; every success ran within ~2–3 min of the
merge, i.e. inside a window that was still open. The change is not in the code (`git blame -L
380,415` — every line is `7e5c2d98`, 2026-08-30, untouched) and, on the available evidence, not in
the setting either (`grep -niE "permission|GITHUB_TOKEN|least.privilege" docs/IMPROVEMENTS.md` → no
matches, so no permissions-hardening item was planned or shipped; `.github/workflows/` contains one
`permissions:` key in total, in the dormant `deploy-production.yml`. GitHub exposes no history for
`default_workflow_permissions`, so a manual flip on 09-03 cannot be positively excluded — it just has
no trace anywhere in the repo or the program). What changed is **how fast the private flip now
happens**: L-057 / PR #609
added `scripts/visibility-watchdog.mjs` (`c009cf83`, 2026-09-04) and the sessions tightened the
window to ~1–2 minutes after the merge. **The guard was silently depending on the public window, and
the discipline that shortened that window is what exposed it.**

**(a) — `deployment_status`-triggered runs get a differently-restricted token. REFUTED.** The
token's permissions come from the repo default / the `permissions:` key, not the event. The one
documented event-specific override in the docs source
(`data/reusables/actions/jobs/section-assigning-permissions-to-jobs.md`) concerns
`pull_request_target` (grants MORE, not less) and forked-PR reads; `deployment_status` is neither,
and no fork is involved. Decisive counter-evidence: the _same event type_, same workflow, same
token config succeeded eight times on 09-01/09-02/09-03.

**(c) — deployments created by a different integration (Railway) are unreadable by the Actions
token. REFUTED.** All deployments in the window were created by the same `railway-app[bot]`
(`probe3.txt`) — including the ones the guard read successfully on 09-01→09-03T06:00. Creator
identity did not change; readability did. No such GitHub rule exists: deployment objects are
repository resources gated by the `deployments` permission, not by their creator.

### What is NOT proven

I could not read a per-minute visibility history (`gh api repos/.../events` returns only stale
duplicate `PublicEvent` rows dated 2026-03-10; `/timing` reports `billable.UBUNTU.total_ms: 0` for
every run, public or private, so billing is not a usable visibility proxy). The private-window
evidence for the two _failing_ runs is documented and exact; for the _succeeding_ runs it is
inferred from "ran ≤ 3 min after the merge, before the flip". The residual uncertainty is only
about **why it worked before**, not about the fix — and it does not change the ruling, because (d)
alone makes the call illegal on a private repo, which is the state the repo is in for essentially
every future `deployment_status` run.

**Experiment that would settle it, if S3 wants it:** one `workflow_dispatch` run while the repo is
**private**, with a step that calls the endpoint twice — once under the job's current permissions,
once from a job carrying `permissions: { contents: read, deployments: read }`. Expected: 403 then 200. (A public-window control run is not needed; the CI history above already is one.)

---

## Alternative design for S3 — permission-free freshness via master's tip

`git ls-remote origin refs/heads/master` (or, cheaper and with no credential plumbing before the
checkout, `gh api "repos/$GITHUB_REPOSITORY/commits/master" --jq .sha`, which needs only
`contents: read` — already in the restricted default) compared with `DEPLOY_SHA`.

**Assessment: works for the case the guard exists for, but regresses the case its own comment
(lines 395–401) says it was designed around. Recommend it only as the _fallback_ inside a fixed
guard, not as the primary.**

Failure modes, each checked against real data:

1. **A `deployment_status` for a non-master ref.** Every deployment in the last 30
   (`probe20.txt`) is `environment: "routeflow / production"` with `ref` = a full master SHA, so
   today this is theoretical. It stops being theoretical under the documented Railway-outage
   fallback (`railway up --service … --ci`, `CLAUDE.md`) and under any future PR/preview
   environment: tip-comparison would then skip a legitimate deployment forever. Mitigation: only
   apply the tip rule when `DEPLOY_SHA` is an ancestor of master; otherwise fail open.
2. **Two services deploying the same SHA.** Not observed — Railway posts **one project-level
   deployment per push**, not one per service (30/30 rows, single environment). If it ever did, both
   runs would see `sha == master HEAD` and both would run; the job's per-SHA
   `concurrency: ci-e2e-${{ github.event.deployment.sha }}` + `cancel-in-progress: true` (lines
   357–359) already collapses them to one. Harmless.
3. **A master push between the deploy and the event → skip. Is that correct?** _Split:_
   - Push **inside** Railway's `watchPatterns` (`apps/api/**`, `apps/web/**`, `packages/**`) → it
     gets its own deployment and its own E2E run. Skipping is **correct**.
   - Push **outside** them (`docs/`, `.claude/`, root files) → **no deployment is ever created**, so
     nothing replaces the skipped run and the shipped code gets **zero** E2E coverage. This is a
     real shape in this repo, not a hypothetical: `70321d0a` (#604), `0cfad7ed` (#605), `91c5333b`
     (#607), `afce1a60` (#600), `c60fe214` (#601) all merged to master in this window and produced
     **no deployment at all**. The exposure window is only the ~2–3 min between the deploy and the
     `deployment_status` event, so it is low-probability — but it is precisely the silent-coverage-
     loss failure this whole bug is about, which makes it a poor trade.
   - Fix that closes it with only `contents: read`: treat the deployment as fresh when
     `DEPLOY_SHA == master HEAD` **or** nothing under the watchPatterns differs between them
     (`gh api …/compare/$DEPLOY_SHA...master`, or `git diff --name-only` after moving the checkout
     ahead of the guard). The readiness gate at line 583 already uses exactly this "no web/packages
     drift ⇒ equivalent" rule, so the idiom is house-consistent.
4. **Force-push / rewritten master.** `DEPLOY_SHA` is not an ancestor → indistinguishable from (1);
   must fail open, not skip.
5. **Railway re-posting `success` on deployment N-1** — the case the guard exists for. Tip
   comparison handles it correctly (N-1 ≠ master HEAD ⇒ skip), which was verified live at
   09-03T06:00:52 by the deployments API version.

**Simplest correct fix, for comparison:** add `permissions: { contents: read, deployments: read }`
to the `e2e` job. Docs confirm a workflow may raise a scope above the repo default —
`data/reusables/actions/jobs/section-assigning-permissions-to-jobs.md`: _"You can use `permissions`
to modify the default permissions granted to the `GITHUB_TOKEN`, adding or removing access as
required"_; only **write** access can be capped by an org/enterprise policy, and `najathakram` is a
personal account. Independently of which design wins, **line 402/403 must be rewritten to branch on
`gh`'s exit status rather than on emptiness** — otherwise the next API failure silently skips again.

### Permission enumeration for the `e2e` job

A job-level `permissions:` block **restricts to exactly what is listed** — workflow-syntax:
_"If you specify the access for any of these permissions, all of those that are not specified are
set to `none`."_ So the block must cover every step:

| Step (line)                                                                                           | Uses `GITHUB_TOKEN`?                                                                                                             | Scope needed                                                       |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Skip superseded deployments (380) — `gh api …/deployments` with `GH_TOKEN: ${{ github.token }}` (383) | yes                                                                                                                              | **`deployments: read`** (on a private repo)                        |
| `actions/checkout@v7` (417), `ref:` + `fetch-depth: 0`                                                | yes (default `token: github.token`)                                                                                              | **`contents: read`**                                               |
| `actions/setup-node@v7` (430), `cache: npm`                                                           | cache service uses `ACTIONS_RUNTIME_TOKEN`, not `GITHUB_TOKEN`; version resolution reads the public `actions/node-versions` repo | none required (`metadata: read` is implicit and cannot be revoked) |
| Install dependencies (436) `npm ci`                                                                   | no (registry.npmjs.org)                                                                                                          | none                                                               |
| Install Playwright browsers (447)                                                                     | no (Playwright CDN)                                                                                                              | none                                                               |
| Wait for the deployed app (478)                                                                       | no — `curl` to Railway + local `git diff`                                                                                        | none                                                               |
| Run Playwright tests (634)                                                                            | no                                                                                                                               | none                                                               |
| `actions/upload-artifact@v7` (652)                                                                    | no — artifact service via `ACTIONS_RUNTIME_TOKEN`                                                                                | none                                                               |

Secrets consumed (**not** gated by `permissions:`, so a block does not break them):
`SMOKE_BASE_URL`, `PLAYWRIGHT_BASE_URL` (481–482, 639), `PLAYWRIGHT_TENANT_SLUG` (640),
`E2E_SEED_DATABASE_URL` (642), `PLAYWRIGHT_SA_USERNAME` / `PLAYWRIGHT_SA_PASSWORD` (644–645).
No `gh` write call exists anywhere in the job.

**⇒ minimal sufficient block: `permissions: { contents: read, deployments: read }`.** Put it on the
**job**, not the workflow: a workflow-level block would also apply to `verify`, which needs only
`contents: read` (its steps are checkout, setup-node, `npm ci`, `prisma generate`, `npm run verify`,
`scripts/ci-audit-critical.mjs` — no GitHub API calls).

---

## Blast radius

**Consumers of `steps.freshness.outputs.run` — 7, all inside the `e2e` job, all `== 'true'`:**
lines **418** (checkout), **431** (setup-node), **437** (install), **448** (Playwright browsers),
**479** (deploy-readiness gate), **635** (run Playwright), **651** (`failure() &&` upload report).
Nothing outside the job reads it; no other job depends on `e2e`. So the single wrong `run=false`
disables the entire post-deploy E2E lane and nothing else — and the job still reports **success**
(the guard is documented as never failing the job, lines 378–379), which is exactly the L-041 trap:
green job, zero real steps.

**Sibling `gh api … || true` captures — none.** `grep -rn "gh api"` over `.github/workflows/`
returns exactly **one** hit: `ci.yml:402`. Over `scripts/` (all depths) and `apps/*/scripts`:
**zero** hits. The only other `gh` subprocess in the repo is `scripts/visibility-watchdog.mjs`
(`gh repo edit --visibility private`), which checks its exit code and logs it (`:174`, `:177`) —
not the same shape.

**Same-shaped `|| true` captures that are NOT bugs** (checked, listed so S3 does not "fix" them):
`ci.yml:518, 519, 555, 566` are `curl -s -o /dev/null -w '%{http_code}'` — `-w` prints the status
code on stdout even on failure and the body goes to `/dev/null` or a temp file, so the captured
value can never be an error body; `ci.yml:574` is a `node -e` that already try/catches and prints
nothing on failure, and the empty result is handled at 596–600. Leave them.

**Adjacent latent risk worth one line in the fix PR:** the guard is the _only_ consumer of a
non-default token scope in the whole repo, so adding a job-level `permissions:` block is
low-blast-radius; but if S3 instead adds a **workflow-level** block it silently narrows `verify`
too, and `verify` is the PR merge gate.

---

## Consequence check — merges since 2026-09-02 whose post-deploy E2E never ran

`git log --oneline --since=2026-09-02 origin/master` cross-referenced with the deployment list and
per-**step** conclusions (L-041: step, never job):

| Merge (UTC)                                                                         | Deployment                   | E2E run     | Real E2E?                                               |
| ----------------------------------------------------------------------------------- | ---------------------------- | ----------- | ------------------------------------------------------- |
| `24421170` #598 09-02T09:09                                                         | 09:10:00                     | 33612887226 | ✅ ran — **failure** (Playwright red; last genuine red) |
| `8da0d5db` #599 09-02T09:34                                                         | 09:34:58                     | 33615066210 | ✅ ran — success                                        |
| `afce1a60` #600 09-02T09:44                                                         | none (outside watchPatterns) | —           | n/a                                                     |
| `c60fe214` #601 09-02T09:46                                                         | none                         | —           | n/a                                                     |
| `d4f85fd2` #602 09-02T15:18                                                         | 15:19:01                     | 33647960494 | ✅ ran — success                                        |
| `d0769701` #603 09-03T04:30                                                         | 04:30:49                     | 33715496781 | ✅ ran — success                                        |
| `70321d0a` #604 09-03T04:56                                                         | none                         | —           | n/a                                                     |
| `0cfad7ed` #605 09-03T05:02                                                         | none                         | —           | n/a                                                     |
| `97de93e1` #606 09-03T05:58                                                         | 05:58:23                     | 33721296323 | ✅ ran — success                                        |
| `91c5333b` #607 09-03T06:44                                                         | none                         | —           | n/a                                                     |
| **`e39bf9db`** #608 (imp-03a: retire boot-time DDL + Prisma drift gate) 09-03T12:30 | 12:30:35                     | 33755924684 | ❌ **NEVER RAN** — wrongly skipped                      |
| **`f60bd27c`** #609 (imp-02 advisory lock + wave D) 09-04T14:41                     | 14:41:39                     | 33885520334 | ❌ **NEVER RAN** — wrongly skipped                      |

**Exactly two shipped commits have no post-deploy E2E evidence: `e39bf9db` and `f60bd27c`.** Both
are backend-behaviour PRs whose "E2E green" was recorded on the strength of a green _job_
(`improvements-program.html` records PR-1's E2E as "success, 10 steps" — the 10 steps are 1 guard +
8 skipped + 1 "Complete job"). Re-running the suite against current production after the fix lands
discharges both at once, since `f60bd27c` contains `e39bf9db`.

The other "skipped" `deployment_status` runs in the window (33885490053, 33885376092, 33885211796,
33755624581, 33715430888, 33715314657, 33647758087, 33614899844, 33612865802, 33612620579,
33584817140, 33557014298, 33554057947, 33721129183) are 0-step job-level skips from the job `if:`
at 343–346 (`deployment_status.state != 'success'` — Railway's `in_progress`/`queued` events) or
per-SHA concurrency cancellation. They are correct and unrelated.
