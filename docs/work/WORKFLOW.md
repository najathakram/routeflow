# How work flows (the work board)

**Links:** [Work board](https://github.com/users/najathakram/projects/3) · [Now: P0 and P1](https://github.com/users/najathakram/projects/3/views/3) · [In flight](https://github.com/users/najathakram/projects/3/views/4) · [Triage inbox](https://github.com/users/najathakram/projects/3/views/5) · [Releases and epics](https://github.com/users/najathakram/projects/3/views/8) · [Owner actions](https://github.com/users/najathakram/projects/3/views/9) · [Roadmap timeline](https://github.com/users/najathakram/projects/3/views/10) · [Releases](https://github.com/najathakram/routeflow/milestones) · live status: the open issue labelled `work-status` · triage rules: [TRIAGE.md](TRIAGE.md)

Every piece of RouteFlow work, whether a bug, feature, customer customization or chore, is a
**GitHub issue in this repo**, tracked on the RouteFlow work board (a GitHub Project). The issue is
the unit of work and its memory: anyone, person or agent, on any account or machine, can pick it up
cold from the issue alone. Sessions forget; issues don't.

> The repo goes public during CI windows, and so do the issues. Never put client names, tenant
> slugs or ids, credentials, connection strings or production data in an issue or comment. Use
> `acme`-style placeholders and client codes. Report a security vulnerability as a private security
> advisory, never as an issue.

## The rules

1. **No ticket, no work.** Anything you're asked to do becomes an issue first. Every branch and PR
   names its issue number.
2. **One issue, one PR.** A feature too big for one PR is a parent (label `epic`) with one
   sub-issue per PR; the parent shows a progress bar.
3. **Status is derived, never typed.** The reconciler sets it from what's actually on GitHub.
4. **One in-progress item per lane.** The `lane:*` label is a file-area lock that an assigned issue
   holds only while it's In progress — once its PR is ready for review (In review), the lane frees up
   — so if it's still busy, pick work from another lane or wait.
5. **Finish before you start.** Clear your In review and Blocked items before claiming new work.
6. **Verdicts live on the PR.** Post SA, Opus and prover results on the PR at the exact sha. #938 is
   only the fleet feed.

## How the board is organized

- **Releases** are milestones (R1, R1.1, R2, R3). Work with no milestone is backlog.
- **Features and epics** carry the `epic` label and are parents. Their **sub-issues** are the work:
  remaining pieces, deferrals (`D-nn`), SA-spec build steps and in-flight PRs.
- **Bugs** carry `kind:bug`, `sev:*` and a `lane:*`. A bug that gates a feature is also its sub-issue.
- **Owner actions** carry `owner-action`: decisions, production runs and sign-offs only the owner
  can do.
- Quick wins, the repo cleanup and the gap backlogs are epics too, so nothing lives in a side file.

## Statuses (derived)

| Status      | Meaning (what the reconciler looks at)                                    |
| ----------- | ------------------------------------------------------------------------- |
| Inbox       | open, labelled `needs-triage`                                             |
| Ready       | triaged, no assignee                                                      |
| In progress | assigned, with a branch or a draft PR                                     |
| In review   | its PR is marked ready for review                                         |
| Blocked     | labelled `blocked:owner` or `blocked` (say what it waits on in a comment) |
| Done        | closed (its PR merged)                                                    |

## Intake: anyone, any wording

Open an issue with one sentence, from your phone if you like, using the **Quick ask** template.
It gets `needs-triage`. The intake agent picks it up on its next sweep and:

1. searches open issues and PRs for a duplicate, and links to it if one exists;
2. finds the area and the files from the code map;
3. sets the kind, severity, priority, lane and release;
4. writes acceptance criteria and a test plan into the issue;
5. removes `needs-triage`, or asks the owner when it isn't sure or the item would bump planned work.

## Priority = severity × urgency

| Severity \ urgency                     | Now (customers hit it) | Soon (this release) | Later |
| -------------------------------------- | ---------------------- | ------------------- | ----- |
| critical (money/data loss, outage)     | **P0**                 | P1                  | P1    |
| high (wrong result, workaround exists) | P1                     | P1                  | P2    |
| medium                                 | P2                     | P2                  | P3    |
| low                                    | P3                     | P3                  | P3    |

- **P0:** drop everything; a hotfix lane takes it immediately.
- **P1:** this week's cycle.
- **P2:** next cycle.
- **P3:** backlog.

Weekly cycle capacity: about 40% critical/high bugs, 40% roadmap features, 20% customer
customizations and unfinished work. Releases are **milestones** (R1, R1.1, R2, R3); the milestone's
progress bar is the release's progress.

## Labels

- `kind:bug` / `kind:feature` / `kind:customization` / `kind:chore` / `kind:migration`
- `sev:critical` / `sev:high` / `sev:medium` / `sev:low`
- `prio:P0` … `prio:P3`
- `lane:*`: the file-area lock (orders, invoices, pricing, returns-regulated, purchasing, scanner,
  routes-delivery, inventory, billing, tooling; `lane:unsorted` until triage places it)
- `tier1`: money, tenancy or migration; needs the SA read plus one Opus pass at the exact sha
- `needs-triage`, `blocked:owner`, `at-risk`

## Claiming work (people and agents)

1. **Pick** the highest-priority Ready issue in a lane that is free (no other assigned open issue with
   the same `lane:*` label).
2. **Claim:** assign yourself, then comment
   `Claimed by <worker>`, where worker = `<person> · <machine> · <session title>`. Several agents
   share one GitHub user, so the worker line is what tells them apart.
3. **Branch** `<kind>/<issue#>-<slug>` off fresh `origin/master`, in its own worktree.
4. **Open a draft PR right away** whose body says `Closes #<issue>` and repeats the worker line. The
   draft PR is the visible claim.
5. **Heartbeat:** push at least once a day while working. Comment on the issue when the stage changes
   (building → testing → in review) or when you're blocked.
6. **Letting go:** comment `Released: <where it stands, branch name>` and unassign. Never leave a
   silent claim.

## Stale claims and drift

## What keeps it current (no one edits the board by hand)

- **Every 5 minutes**, a scheduled task on the owner's PC runs `scripts/work/run.mjs`: the reconciler
  (`reconcile.mjs --apply`; by hand, `npm run work:reconcile` is a dry run and
  `npm run work:reconcile:apply` writes) derives every item's fields, adds new issues and PRs, closes issues
  whose PR merged, and rewrites the pinned `work-status` digest issue. Once a day, or when the
  overall state changes, it also posts an on-track / at-risk update on the board.
- **Instantly**, `npm run work:claim` (claim or release) triggers a refresh.
- **Plane** gets release progress from `npm run work:plane-release`: at most 3 times a day and only
  when a release moved; a closed milestone always syncs. Plane is otherwise read-only.

The reconciler also checks for drift:

- no push for 24 h: the worker is flagged;
- no push for 72 h: the issue goes back to Ready, and the branch is kept;
- a PR with no `Closes #N`: flagged for the lead;
- two in-progress issues in one lane: flagged for the lead;
- a PR in review for more than 48 h, or with red CI: goes into the lead's queue;
- a branch behind master or conflicting: the worker is flagged;
- a milestone whose open work can't fit before its due date: labelled `at-risk`.

## Where things were before

The bug registry (`.claude/campaign/bugs.jsonl`) and the roadmap registers (`.claude/roadmap/`) were
imported on 2026-09-24: every roadmap feature that wasn't done, and every open critical/high bug.
Medium and low bugs stay in the registry and get an issue when someone picks them. From now on,
**status lives on the issue**. The registry keeps the ids and detail files. Plane is read-only.
