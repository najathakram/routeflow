# Runbook

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** developers and the owner operating
bugflow day to day — onboarding, incident handling, and the weekly health check

This is the copy-pasteable procedure set for running bugflow once it exists: bringing a developer or
a fleet seat onto it, the automated Routines that keep it honest, filing and approving bugs by hand,
recovering from the failure modes a lease-and-label system actually has, and the checklist that
decides whether its knobs need tuning. It assumes [CLI.md](CLI.md)'s commands,
[WORKERS.md](WORKERS.md)'s three surfaces, and [CLAIMS-AND-LEASES.md](CLAIMS-AND-LEASES.md)'s
compare-and-swap — read those first if a command below is unfamiliar. Every `gh`/`bugflow` command
here is meant to be run as written, not adapted.

## Prerequisites (every procedure below assumes these)

```bash
gh auth status                 # confirms who you're authenticated as, and that the token is valid
cat tools/bugflow/bugflow.config.json | head -5   # confirms you're in a checkout that has it
```

---

## 1. Onboard a developer

1. `gh auth login` once per machine (browser flow). `gh auth status` should show the developer's own
   GitHub login with `repo` and `project` scopes.
2. Confirm collaborator access: the owner adds the login with push access
   (`gh api repos/<org>/routeflow/collaborators/<login> -X PUT -f permission=push`, or via the GitHub
   UI) and to the Projects v2 board named in `bugflow.config.json`'s `project` field.
3. Install the Desktop scheduled task from the shipped template:
   ```bash
   mkdir -p ~/.claude/scheduled-tasks/bugflow-worker
   cp tools/bugflow/templates/scheduled-task.SKILL.md ~/.claude/scheduled-tasks/bugflow-worker/SKILL.md
   ```
   Then in the Claude Code app: Code tab → Routines → New routine → **Local** → name it
   `bugflow-worker`, point Instructions at that file, set the working folder to this checkout.
4. **Turn the isolated-worktree toggle ON.** This is not optional — claim identity is
   `login/host/worktree` (see CLAIMS-AND-LEASES.md), and a task running against the developer's own
   interactive checkout instead of its own worktree can claim a bug out from under whatever the
   developer is doing by hand.
5. Schedule: every 30 minutes (WORKERS.md's job→surface table — comfortably longer than one run's
   45-minute cap, so ticks never queue behind each other).
6. Run it once manually, watch the diff and the PR it opens, then mark "always allow" for that
   permission set so later runs are unattended.
7. Smoke-test from that worktree: `bugflow next --seat <login>` should return either a takeable batch
   or "nothing takeable" — never a `gh` auth error (if it does, see §10).

## 2. Add a fleet seat

A fleet seat is a GitHub **machine-user account owned by the org**, on its own Claude Code Team
seat — never a real developer's personal login pressed into unattended service, and it can never
approve a PR (see [GUARDRAILS.md](GUARDRAILS.md)). `VERIFY:` GitHub ToS on machine-user accounts
before provisioning one — the only piece of this that isn't already decided.

1. Provision the dedicated GitHub machine-user account for the seat (never a developer's personal
   login — WORKERS.md's Identity section explains why: attribution and subscription budget both
   need to stay separate from a real person's).
2. Grant it `push` access to the repo, same as a developer.
3. Provision a Claude Code subscription seat for that account.
4. `gh auth login` as that account on whatever machine or environment will run its worker (a Desktop
   task on an always-on machine at a 5-minute schedule, or a cloud Routine accepting the 1-hour
   scheduling floor — WORKERS.md's Capacity section).
5. Add its config entry:
   ```json
   "seats": {
     "<fleet-login>": { "allowedClasses": ["agent-safe"], "dailyClaimCap": 6 }
   }
   ```
   Fleet seats get `agent-safe` only, full stop — not even a `parked` bug that later gets
   `approved:owner`, per the decision brief's carve-out. Only a developer's own interactive claim (or
   explicit owner action) may touch a parked class.
6. Exclude it from every required-reviewer rule by design — a fleet seat never approves a PR,
   including its own. `VERIFY:` this repo has **no `CODEOWNERS` file today** (checked: the only
   match anywhere in either worktree is inside a dependency's `node_modules`), so there is nothing
   to add it to yet; when one is introduced as part of turning on branch protection/merge queue for
   bugflow (see [GUARDRAILS.md](GUARDRAILS.md)), the fleet login goes on the "not a valid reviewer"
   side of it as a matter of course, not a fresh decision.
7. Repeat the Desktop-task or cloud-Routine setup from §1 under the fleet account, then confirm
   `bugflow next --seat <fleet-login>` only ever offers `class:agent-safe` work.

## 3. Create the housekeeping and triage cloud Routines

1. Confirm `tools/bugflow/templates/routine-housekeeping.md` and `routine-triage.md` exist.
2. Claude Code → Routines → New routine → **Cloud**. Repo: this one (Routines clone the default
   branch fresh each run — nothing to configure there).
3. **Housekeeping routine** — prompt = `routine-housekeeping.md`'s contents (`bugflow reap`,
   `bugflow sync --quiet`, the Witness checks, `bugflow snapshot` once daily, in that order —
   `reap` must free leases before `sync` derives status from them). Trigger: Schedule, hourly
   (WORKERS.md's job→surface table —
   bounds a stale lease to at most ~30 minutes past its 90-minute expiry before the next tick catches
   it).
4. **Triage routine** — prompt = `routine-triage.md`'s contents (classify queued
   `status:triage` bugs into `ready`/`parked`/`blocked`). Trigger: Schedule, nightly (per
   WORKERS.md — triage is not claim-latency-sensitive the way a lease is, and batching it overnight
   matches the campaign's existing per-batch analysis convention).
5. Pick which account owns each Routine deliberately — it acts as that account's GitHub identity and
   draws down its subscription usage (WORKERS.md's Identity section). The owner's own account is the
   simplest choice for both, since neither writes code or opens PRs.
6. Save, let the first run of each complete once, and read what it actually did (`gh issue list
   --label status:triage`, `bugflow board`) before trusting it unattended.
7. Rotating either Routine's fire token: see §13.

## 4. File a bug

**From a customer report** — paraphrase, never quote the client's own words verbatim if they name
the business, and never include a slug, invoice number, or tenant UUID (CLAUDE.md's test-tenant
policy applies to every artifact bugflow writes, issues included):

```bash
bugflow file "<one-line title>" --severity high --area orders --source customer \
  --symptom "<what was reported, in acme-style language, no client identifiers>" \
  --files "apps/api/src/orders/orders.service.ts"
```

**From a monitoring alert** — file immediately, don't wait for the nightly triage Routine, since an
alert is time-sensitive by definition:

```bash
bugflow file "<alert-derived title>" --severity critical --area api --source monitor \
  --symptom "<alert name/threshold; ids and amounts only, never a client identifier>"
```

Either way, follow with triage as soon as severity/tier/files are known (don't wait for the nightly
Routine on anything `critical`):

```bash
bugflow triage #<N> --class agent-safe --tier t1 --severity high --area orders \
  --files "apps/api/src/orders/orders.service.ts"
```

## 5. Approve a parked bug

```bash
gh issue edit <N> --add-label "approved:owner"
bugflow sync --quiet
```

`approved:owner` is a marker no `bugflow` command ever writes on its own (CLI.md's Labels table — a
fleet seat must never be able to approve its own carve-out bug). Confirm with
`gh issue view <N> --json labels` that it now carries `status:ready` and `harness:full` — a parked
bug always routes to the full tier (the `bug-pipeline` skill) regardless of file count; the carve-out
is exactly the line Ralph must never cross unattended.

## 6. Handle `needs:human`

1. `bugflow brief <N>` for the plan/context, then `gh issue view <N> --comments` for the specific
   attempts comment a capped-out Ralph-tier run left behind (WORKERS.md's release-on-failure step).
2. Decide: fix it yourself, re-scope the bug (edit its `## Files` list, or split it into two issues),
   or re-classify it (if the attempts comment reveals it actually touches money/tenancy/migration,
   add the right `class:` label so it parks instead of looping again).
3. Clear it once resolved:
   ```bash
   gh issue edit <N> --remove-label "needs:human"
   bugflow release <N> --reason "unblocked: <what changed>"
   ```

## 7. Handle a stuck claim

```bash
bugflow reap   # releases every expired lease (90 min), repo-wide, from any machine
```

For a claim that looks stuck but hasn't hit the 90-minute lease yet (a worker's machine crashed or
lost its session mid-run):

```bash
gh issue view <N> --json assignees,comments   # confirm no recent heartbeat comment
bugflow release <N> --reason "manual: worker unresponsive"
```

`release` posts the same kind of release comment `reap` would — never delete a claim comment by hand,
since the compare-and-swap history (CLAIMS-AND-LEASES.md) depends on every claim/release being a
comment, never an edit or deletion.

## 8. Handle `regressed`

```bash
bugflow verify --deploy <sha> --result red
```

Per CLI.md, this reopens exactly the bugs whose specific `REG-#N` token failed in that deploy's
post-deploy check or E2E run (never a blanket regress of every `verifying` bug against one red
deploy), bumps `severity`, and clears the stale PR/proof pointer so `status:ready` makes it
re-offerable. If a regression is caught by other means (a support report, a manual test), the same
citation discipline applies as the legacy `bugs.mjs reopen --why`: cite the failing `REG-#N`/`REG-B###`
token or the run/deploy that showed it — `regressed` is a real state, not a re-file under a fresh
number.

## 9. A worker pushed to the wrong branch

1. `gh pr list --head <bad-branch>` to see whether a PR already opened against it.
2. Wrong base, PR still useful: `gh pr edit <num> --base master`. Wrong branch entirely: close it and
   push the same commits to a correctly-named one.
3. If commits landed directly on a shared branch (another worker's, or `master`) by mistake:
   cherry-pick them onto a correctly-named throwaway branch, then delete/force-push only that
   throwaway — never force-push a shared branch.
4. Release the claim so the batch is retried cleanly:
   ```bash
   bugflow release <N> --reason "wrong-branch recovery"
   ```
5. If this recurs, the worker prompt's branch-naming instruction (WORKERS.md's "what a worker prompt
   must contain") is probably ambiguous — fix the template, not just this one run.

## 10. Rate-limit or `gh` auth failure (exit 5)

```bash
gh auth status         # which account, and whether the token is valid
gh api rate_limit       # remaining calls and reset time
```

- Auth expired/invalid → `gh auth login` again for that seat.
- Rate-limited → back off until `resources.core.reset`; let the next scheduled tick retry rather than
  tight-looping by hand.
- A fleet seat's cloud Routine failing this way → also check §14 (`automation.enabled`) isn't the
  actual cause before assuming it's really a `gh` problem — a paused-automation refusal is exit `4`
  (not takeable), not `5`, so the two are distinguishable from the exit code alone.

## 11. Rebuild the Projects board from labels

```bash
bugflow sync --quiet
```

There is no separate "rebuild" command because `sync` already re-derives every Project v2 field from
current labels on every run (CLI.md) — labels are the source of truth, sync mirrors them, never the
reverse. Run this after any manual Projects-UI edit that might have drifted from the labels.

## 12. Restore the record from the snapshot branch (disaster recovery)

```bash
git fetch origin claude/bugflow-snapshot
git log origin/claude/bugflow-snapshot -- snapshot/issues.jsonl   # find the snapshot to restore from
git show <sha>:snapshot/issues.jsonl > restore-issues.jsonl
git show origin/claude/bugflow-snapshot:snapshot/events.jsonl > restore-events.jsonl
git show origin/claude/bugflow-snapshot:snapshot/meta.json > restore-meta.json
```

`issues.jsonl` is a full replace-in-place export of every issue's fields as of the last `bugflow
snapshot`; `events.jsonl` is an append-only log of transitions since, appended only past
`meta.json`'s high-water mark (the last processed timeline event id/timestamp — see CLI.md).
Reconcile the live board against `restore-issues.jsonl` (`gh issue edit <N>
--add-label/--remove-label`, `--set-parent`), then replay any `restore-events.jsonl` rows dated
after that snapshot's own timestamp. There is still no `bugflow` command that automates this
replay — treat it as a manual `gh` reconciliation, and rehearse it once against a throwaway
`qa-bugflow-*` repo before ever relying on it for real.

## 13. Rotate a routine's API token

A cloud Routine fired by `POST …/fire` uses a per-routine bearer token (WORKERS.md).

1. In that Routine's settings, regenerate the token. `VERIFY:` exact UI path — not covered by the
   decision brief.
2. Update every external caller that stores the old value (a monitoring webhook, a CI step) — never
   commit a routine token to the repo; it is a secret exactly like `JWT_SECRET`.
3. Confirm the old token is rejected and the new one fires successfully before considering the
   rotation done.

## 14. Pause all automation (owner kill switch)

Three independent switches — pull all three, since any one alone leaves a path live:

1. **Routines, org-wide:** the org/Team-Enterprise admin control to disable Routines
   (WORKERS.md/decision brief: "Team/Enterprise owners can disable them org-wide"). `VERIFY:` exact
   menu path.
2. **Desktop scheduled tasks, per machine:** pause or delete each `bugflow-*` task (Code tab →
   Routines → the local task) — only stops that one machine, so do it on every machine running one.
3. **The config flag** — the one switch that also stops a worker that already has the repo checked
   out, because `bugflow next` reads it fresh every call:
   ```bash
   # tools/bugflow/bugflow.config.json
   { "automation": { "enabled": false } }
   ```
   ```bash
   git add tools/bugflow/bugflow.config.json
   git commit -m "chore(bugflow): pause automation"
   git push
   ```
   With this flag set, `bugflow next` returns exit `4` (not takeable) for every seat, regardless of
   what is otherwise `status:ready`.
4. Confirm: `bugflow next --seat <any>` reports automation paused, not an empty wave.
5. To resume, reverse all three in the same order (flag back to `true` last, so nothing races ahead
   of a Routine or Desktop task that hasn't actually been re-enabled yet).

## 15. Weekly review checklist

- **Throughput:** count `status:done` transitions in the last 7 days vs. the prior week
  (`bugflow board --json`, or the Projects view grouped by the `status` field).
- **Time-in-status:** derive median hours per transition (`ready→claimed`, `claimed→in_progress`,
  `in_review→verifying`) from `snapshot/events.jsonl`. A growing `ready` backlog next to a flat
  `claimed` rate says capacity is the bottleneck, not planning.
- **Ledger cost per resolved bug:** sum `.claude/pipeline/cost-ledger.jsonl` rows whose run closed a
  `REG-#N`/`REG-B###` token that week, divide by bugs closed. Compare Ralph-tier cost/bug against
  full-tier cost/bug ([HARNESS.md](HARNESS.md)) — the split should be moving toward Ralph, not away
  from it.
- **First-pass success rate:** Ralph-tier PRs merged without a `needs:human` release, divided by
  Ralph-tier attempts that week — the one figure WORKERS.md's capacity formula
  (`fleet seats × runs/day × first-pass success rate`) needs real numbers for.
- **Regressions:** count `status:regressed` transitions. A rising rate says the proof gate
  (`bugflow check`) or the deploy check (`bugflow verify`) is being satisfied too easily — revisit
  [HARNESS.md](HARNESS.md)'s gating before loosening anything else.
- **Cap tuning:** change `ralph.maxIterations`, `batch.maxBugs`, or any seat's `dailyClaimCap` only
  after **ten runs** of ledger evidence support the change (`model-routing`'s ten-run rule) — never
  off one bad run, and never on taste.

## Open questions

- `VERIFY:` exact collaborator/Projects-access grant commands above (step 2 of §1) — written to the
  shape `gh api`/`gh project` support today; confirm against the actual `gh` version pinned once
  bugflow is implemented.
- `VERIFY:` GitHub's terms of service on machine-user accounts (§2) before provisioning a fleet
  seat's GitHub identity — the only unresolved piece of fleet-seat provisioning; the shape itself
  (org-owned machine user, own Team seat, never approves) is decided (see WORKERS.md).
- `VERIFY:` CODEOWNERS (§2.6) — no such file exists in this repo today; write the exclusion rule only
  once one is introduced.
- `VERIFY:` token-rotation UI path (§13) and the org-wide Routines pause control (§14.1) — both are
  product-surface facts outside what the decision brief or the code in this repo can confirm.
