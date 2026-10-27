---
name: bug-swarm
description: Fix a BATCH of LOW-risk RouteFlow bugs with short-lived agent swarms. Haiku triages and clusters bugs by the files they touch, one Sonnet builder per cluster fixes them test-first in its own worktree, a scripted gate verifies, one Opus reviewer reads each cluster PR, and the lead lands the batch in one window. The orchestrator's context stays flat because every agent dies with its context. Use when asked to "fix a bunch of bugs", "bug swarm", "/bug-swarm", "clear the LOW bugs", "batch the small fixes", or when the bug register has several LOW rows waiting. HIGH-risk bugs (money, ledger, units, locks, tenancy, migrations, billing, auth) never enter the swarm; they go to bug-pipeline one by one.
---

# /bug-swarm

Spec and rationale: `rf-specs-handoff/specs/fleet/BUG-SWARM.md` (owner-approved 2026-10-22). This file is the
procedure. **v0** (now) runs the steps with Agent subagents. **v1** moves steps 2, 5 and 8 into scripts and a
Workflow script once v0 has proven them on the ledger. Improve it through the learning clause below, never on taste.

## When to use (and when not to)

- **Use:** 3 or more LOW register rows. LOW means wording, layout, copy, a missing guard on display-only
  state, a test or tooling defect, or a small validation gap with no money effect.
- **Do not:** any HIGH class above, a migration, or a bug whose repro needs a live-tenant reading. Route those
  to `bug-pipeline`. A cluster that turns out to touch a HIGH path mid-build stops and is re-routed.
- **Budget:** a per-batch cap (default 2% weekly). Check `get_usage` before each step; at the cap, stop at the
  next cluster boundary. Never start a swarm at or above the 95% ladder without the owner's yes.

## Steps (v0)

1. **Triage, Haiku @ low, one agent for the whole batch.** Input: the bug ids. For each bug: the register
   row + its `bugs.mjs` card → `risk` (LOW|HIGH, with the reason), `files` (code-map INDEX +
   `scripts/graph.mjs radius`), `needsDb` (prisma, a `*.db.spec`, or a transaction path), `ui` (yes/no), and a
   one-line repro. Output: `manifest.json` in the run dir `.claude/pipeline/<date>-bug-swarm-<n>/`. The lead's
   context reads only the table.
2. **Cluster, the lead by hand in v0 (v1: `scripts/cluster.mjs`).** Union bugs that share any file. A file at
   its size-ratchet ceiling (`apps/api/src/common/size-ratchet.spec.ts`) forces its bugs into one cluster with an
   extraction-first task. Run ≤ 4 clusters at once per machine.
3. **Context pack, Sonnet @ low, one per cluster.** Signatures of the cluster's files, the graph radius, and the
   relevant LESSONS ids, pinned to the base sha, ≤ 6 KB, written to the run dir. Every agent in the cluster
   starts from it (a stable prefix, prompt-cache friendly).
4. **Build, Sonnet @ medium, one builder per cluster** (`isolation: "worktree"`, branch
   `fix/swarm-<n>-<cluster>`). Bugs in sequence, each: a red-first test that fails on the bug's own wrong value
   (observe and report it), then the minimal fix, then one commit `fix(<area>): … (B###)`. Editing an existing
   assertion is allowed only with a `SPEC-EDIT: <file:line> <why>` line in the manifest. A HEAD trailer
   `Bookkeeping-Follow-Up: pending`. The builder ends with ≤ 3 lines of result plus ONE lesson candidate.
5. **Gate, the lead runs it, no LLM** (v1: `scripts/gate.sh`). Targeted jest for the touched workspaces,
   `check-types`, lint on the touched files, `size-ratchet.spec`, the bug-signature scan, and
   `npm run local:test:db` for needsDb clusters (fresh `rf_dbspec_*` DB). UI clusters: captures at 1440/768/390.
   RED → one fix round for the same builder (resume it), then park the cluster with its log.
6. **Review, Opus @ medium, one independent reviewer per cluster PR.** Input: the manifest rows, the diff,
   the gate output and every `SPEC-EDIT` line as a required question. Cap ≤ 12 tool calls. Return
   PASS|FAIL plus MUSTs. The verdict goes on the board (#3686) at the exact sha.
7. **Land, the lead.** One public window per batch. merge-gate.sh per PR. After each merge, a cluster sharing a
   package update-branches and re-runs CI (L-335). Never flip private while a deploy is BUILDING.
8. **Close, Haiku @ low.** `node scripts/campaign/bugs.mjs prove B### --pr N` per bug; `rf status <row> live`
   after the deploy; lesson candidates go to the bookkeeping follow-up PR; then the ledger row (below).

## Measurement (mandatory, every run)

Append one ledger row per batch: `node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append
<run-dir>/result.json --run <date>-bug-swarm-<n> --approach dev-pipeline --profile bug-swarm --note "<bugs>"`.
`result.json` carries, per batch and per bug:

- **Cost:** tokens and $ per agent role (`session-usage.mjs`), total and **per bug fixed**.
- **Speed:** wall clock from triage start to the last merge; builder minutes per bug.
- **Quality:** first-pass gate pass rate; review MUSTs per PR; `SPEC-EDIT` count and how many the reviewer
  rejected; post-merge regressions within 7 days (`bug-registry` rows citing the PR).
- **Baseline:** compare with `pipeline-ledger.mjs summary --profile bug-pipeline` (LOW rows) and with the last
  10 single-PR LOW fixes. Report the ratio, cost per bug and minutes per bug, in the run's RUN-LOG entry.
  **Adopt as the default for LOW batches** when 3 runs show cost per bug ≤ 0.5× the baseline and first-pass gate
  rate and post-merge regression rate no worse. **Retire** a step that never changes an outcome in 3 runs; **add**
  a guard after any regression it should have caught.

## Learning clause (improve as we go)

After every run: (1) the ledger row; (2) one RUN-LOG entry, `.claude/pipeline/<run>/RUN-LOG.md`, with what was
slow, what was wasted and what a gate caught; (3) a change to THIS file only when the ledger supports it, with the run
id cited in the commit body. v1 work (scripts/cluster.mjs, scripts/gate.sh, a Workflow script) is tracked as
board item W-653; build it only after v0 has 2 ledger rows.

## DO NOT

- Do not put a HIGH bug in a swarm, or "just this once" a money fix.
- Do not let a builder merge, flip visibility, run railway, or touch a live tenant.
- Do not accept a `SPEC-EDIT` on the builder's word; it is a reviewer question.
- Do not run more than one gate per machine at a time (`scripts/heavy-slot.mjs`).
- Do not grow the lead's context: read the manifests and verdict lines, never agent transcripts.

## v1 (scripts + Workflow)

Evidence: runs `2026-10-23-bug-swarm-1` and `2026-10-23-bug-swarm-2`. The orchestrator carried 62-70% of
cost, the hand-typed gate broke twice (unquoted `(dashboard)` paths, a drifting `origin/master..HEAD`), and a
cloned stale `packages/*/dist` failed web tsc. v1 moves the deterministic work into scripts and the agent
choreography into one Workflow script. The v0 steps above stay valid as the fallback.

- **Run:** the Workflow tool with `scriptPath: .claude/skills/bug-swarm/workflow.js` and `args`
  `{ run, rows, idSpace, repo, runDir, fromWorktree, maxClusters, avoidFiles? }` (`scriptsDir`, `registerPath` optional).
  `idSpace` is REQUIRED, `row` (WORK-REGISTER rows, W- ids, via `rf.mjs item show`) or `bug` (B### via
  `bugs.mjs show`); there is no default, because run 2026-10-23-bug-swarm-3 fixed the wrong bug by resolving rows as B### ids.
- **Scripts** (`scripts/`): `cluster.mjs` (union by shared file, ratchet files, cap), `worktree.mjs` (worktree + hooks guard (B642, exit 1 if missing) +
  cloned node_modules + packages build + prisma generate), `gate.mjs` (argv-array gate on the merge-base diff,
  `--json`, `--needs-db`). `workflow.dry-run.mjs` proves the workflow against stubbed agents; run it with
  `node --test .claude/skills/bug-swarm/scripts/*.test.mjs` after any edit to `workflow.js`.
- `gate.mjs` replaces the planned `gate.sh` (lead-accepted): argv arrays, no shell, because shell quoting broke the hand gate twice in runs 1-2.
- **The HIGH guard is path-based.** A change's class is the highest class of any path it touches, from the
  checked-in rule list in `scripts/lib/risk-paths.mjs` (`green < amber < red < black`). `gate.mjs` runs a
  `risk-class` step (`node scripts/risk-class.mjs --base <merge-base> --max amber`) and FAILS on any red or
  black path, naming the path and its rule; a test file under a red directory is red. Triage's `risk` label is
  the second signal, not the guard: a mislabelled row now stops at the gate. Review is still the backstop.
  **Run `gate.mjs` from the lead's checkout** (cwd = the builder worktree, script path = the lead's copy): the gate
  runs the classifier from its own checkout with `--repo <worktree>` and takes the rules from the base ref, so a
  diff cannot edit the judge. Every file the judge imports is red; never run a worktree's own copy of `gate.mjs`.
- **Resolver (run 2026-10-23-bug-swarm-4):** `cluster.mjs` runs `rf.mjs` / `bugs.mjs` from its own checkout (`--repo` only
  as a fallback), shows the resolver's stderr in the reason, and decodes HTML entities and `›`/`»` before comparing titles.
- **Workspace key (run 2026-10-23-bug-swarm-4):** files outside `apps/*` and `packages/*` key on their top-level dir (file name
  at the root), so the cap merge never groups `tools/` with a root docker-compose change.
- **Label as given (run 2026-10-23-bug-swarm-4):** commits and tests carry the id exactly as given in `idSpace` (`row 599`,
  `W-679`, `B668`); `gate.mjs --ids a,b --id-space row|bug` adds an `id-labels` step that fails on a `(B###)` subject
  outside the given ids; a bare `B123` word counts too, so pass `--ids 599,B123` when a branch legitimately
  names a bug.
- **Census (run 2026-10-23-bug-swarm-4, #3659; review of #3674):** a branch that touches ANY file under
  `apps/api/prisma/`, `apps/api/scripts/` or `scripts/` (add, modify, delete, rename or copy; both paths of a move,
  `--diff-filter=ACMRD`) runs the FULL api lanes in `gate.mjs`: `npm test -w apps/api` (parallel + serial `-script` lanes) and `npx jest -c jest.repo-truth.config.js`
  in `apps/api`, 30 minutes each. A hand-listed subset of census specs missed about 25 scanners, so none is kept.
- **Workflow:** Triage+Pack (sonnet) -> Cluster (haiku) -> per cluster Build (sonnet) -> Gate (haiku,
  one build fix round) -> Review (opus, one fix round plus re-check), then a Report. A red cluster is parked.
- **Stays with the orchestrator:** push, PRs, captures for UI clusters, the public window and landing, the
  ledger row and RUN-LOG (v0 steps 7 and 8). No agent pushes or merges.
- **Folded, applied:** Triage and the context pack are ONE sonnet @ low agent per batch, before clustering
  (it resolves ids, verifies liveness with file:line, writes `manifest.json` and a pack per bug). Applied after
  runs 2026-10-23-bug-swarm-1/-2/-3: triage was wrong in 3 of 3 (8 not-live rows called live in run 1; a duplicate
  in run 2; the wrong id space in run 3) and the pack re-verified every row anyway.
