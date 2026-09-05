# 3. bugflow — GitHub-native bug tracking and fix automation

- **Status:** Proposed
- **Date:** 2026-09-04
- **Deciders:** RouteFlow maintainers
- **Related:** [`.claude/skills/bug-registry/SKILL.md`](../../.claude/skills/bug-registry/SKILL.md)
  (the current three-store model this ADR replaces), [`CLAUDE.md`](../../CLAUDE.md) (§ Pipeline
  law, § Lessons learned routine), [`tools/bugflow/README.md`](../../tools/bugflow/README.md) and
  the rest of the `tools/bugflow/docs/` set (the design this ADR authorizes), the
  `model-routing`/`bug-pipeline`/`dev-pipeline` global skills (unaffected by this decision —
  bugflow's Ralph tier and full tier both call into them, see
  [`tools/bugflow/docs/HARNESS.md`](../../tools/bugflow/docs/HARNESS.md))

## Context and problem statement

RouteFlow has been running a bug-fixing campaign against an in-repo registry with three stores:
`.claude/campaign/bugs/B###.md` (what a bug *is*), `.claude/campaign/status/F##.jsonl` (what a bug
*is doing*, guarded by `scripts/campaign-check.mjs`'s proof gate), and a GitHub Issues board
derived by `scripts/team/team.mjs` (what is *in flight*). The status ledger (31 shards), an earlier
revision of the proof gate (487 lines), `team.mjs`, and the `bug-registry` skill (describing an
earlier two-store version of this model) all live on `master`; the bug-record store —
`scripts/campaign/bugs.mjs`, the 7,300-line catalogue CLI that adds the bug-record store, the
`classify()` carve-out, the wave-scheduling algorithm, and a mkdir-lockdir concurrency mechanism
protecting the ledger and catalogue files, plus `.claude/hooks/stop.mjs`'s Gate 4 — merged to
`master` via PR #597 (`10ddc3fa`, 2026-09-05) too, along with its 212 bug records. That means both
defects below, and the pid-liveness lockdir and worktree-name claim identity they root in, are now
live in the registry every session runs, not confined to a branch most sessions never touched —
which strengthens rather than weakens the case for replacing the mechanism. That PR is where both
defects below were introduced, which matters for Option 1 below: fixing them now means patching
code every session already depends on.

The registry was built and has operated correctly under an assumption that no longer holds: **one
machine, one GitHub account, one session at a time.** Two concrete defects follow directly from
that assumption breaking as the campaign moves toward several developers' machines and, per the
`model-routing` skill's capacity math, toward dedicated "fleet" seats running unattended:

1. **The ledger's concurrency control is process-liveness-based, and process liveness is a
   single-machine concept.** `bugs.mjs`'s `acquireLock`/`releaseLock` protect
   `status/F##.jsonl`/`bugs.jsonl` with a `mkdir`-created lock directory whose owner is broken by
   checking `process.kill(pid, 0)` against a boot-epoch stamp (imperfect even on one machine — per
   **L-070**, signal 0 alone succeeds for an unreaped POSIX zombie, so the check also needs a
   `/proc/<pid>/stat` state-`Z` read). A pid recorded by one machine's lock
   is neither checkable nor even visible from another machine's filesystem — each machine has its
   own copy of the lock directory on its own disk. The real cross-machine hazard is one level up:
   two developers' machines each believe they hold no lock (because neither can see the other's),
   each read-modify-write the same git-tracked `status/F##.jsonl`, and when their branches merge,
   git offers no equivalent of the lock's "lost update" protection for a plain tracked text file —
   the result is a silent merge or an unresolved conflict on rewritten JSONL rows, exactly the
   failure the lockdir exists to prevent, just one layer removed from where it can reach.
2. **Claim identity is the bare worktree directory name, which collides across developers.**
   Both `team.mjs`'s and `bugs.mjs`'s own `claimId()` resolve to
   `path.basename(git rev-parse --show-toplevel)` unless an `RF_CLAIM_ID` environment variable
   overrides it — an override nothing sets in practice — stable across `/resume` and context
   compaction (which pids and session names are not), and a deliberate choice given every Claude
   Code session on one box authenticates as the same GitHub account, so `@me` carries no signal.
   But nothing in that string names *which machine* or *which developer* — two people who both
   name their worktree the repository's own convention (e.g. `rf-registry`) produce byte-identical
   claim ids. The comment-CAS itself still resolves the race correctly (GitHub's server-ordered
   comment ids are the real compare-and-swap, independent of what the identity string says); what
   breaks is a human's or `reap`'s ability to tell the two apart when it matters — "who actually
   holds this, let me go ask them" has no answer.

Both defects share a root cause: the registry's *law* (the carve-out, the proof gate, the wave
scheduler) is well-designed and worth keeping, but its *record* is a plain git-tracked file, and a
plain git-tracked file has no concept of a concurrent writer arbitrated by anything other than git
merge semantics. Meanwhile the growth path this campaign is already on — from one interactive
session, to several developers' desktop scheduled tasks, to cloud Routines, to dedicated fleet
seats (see the `model-routing` skill and [`tools/bugflow/docs/ROADMAP.md`](../../tools/bugflow/docs/ROADMAP.md))
— is a growth path in exactly the dimension (concurrent writers, multiple machines, no shared
process table) the current record cannot support no matter how carefully its lock code is
patched.

Constraints that shaped the decision:

- **Workers are Claude Code on subscription seats only** — no Claude API key, no Agent SDK, no
  GitHub-Actions-hosted agent. Whatever holds the record has to be reachable by a `gh`-authenticated
  CLI call and nothing heavier.
- **Routines run with no permission prompts.** Every guard the current system enforces by a human
  glancing at a diff (the carve-out, the proof gate) has to be enforceable by a required check, a
  ruleset, or a refusal baked into the CLI — never by "an agent will notice."
- **The core must be extractable.** RouteFlow-specific knowledge (which files are money-shaped,
  which are hub files, who the seats are) has to live in one config file, never in the tool's own
  source, so the tool can move to its own repository without a rewrite.
- **Node ≥ 20, ESM, Jest only, ESLint flat config + Prettier, Conventional Commits** — the same
  toolchain constraints as every other RouteFlow package (`CLAUDE.md` § DO NOT introduce).

Industry precedent for "an agent claims a tracked unit of work and opens a PR against it" is not
novel — GitHub's own Copilot coding agent already does assign-issue→PR; Linear ships an
agent-assignment surface; the beads/`bd` project and the "Gas Town" pattern of Refinery/Witness
roles designs specifically for agent fleets working a git-native queue; the Ralph loop and
mini-swe-agent are the reproduce→fix→verify shape bugflow's Ralph tier already names itself after.
None of these are adopted as dependencies here — they are cited because the shape of the problem
(a queue of claimable work items, worked by autonomous agents, arbitrated across machines) is a
solved shape elsewhere, which is part of why Option 4 below is a safe bet rather than a novel risk.

## Decision

Adopt **bugflow**, a new package `@routeflow/bugflow` at `tools/bugflow/` (a future `tools/*` npm
workspace; not wired into the root `package.json` in this docs-only change), replacing the
bespoke ledger with three layers:

1. **RECORD = GitHub.** One Issue per bug (issue type `Bug`; the issue number is the bug id).
   Batches are parent issues (type `Batch`) with bugs as sub-issues. Dependencies use GitHub's
   native blocked-by/blocking (GA since August 2025). GitHub Projects v2 is the dashboard. Labels
   are the CLI's source of truth; `bugflow sync` mirrors them into Project fields, never the
   reverse.
2. **WORKERS = Claude Code on subscription seats.** Desktop scheduled tasks today (worktree
   isolation toggled on), cloud Routines for housekeeping/triage, dedicated fleet seats later.
3. **LAW = the repo.** Hooks, the ported `classify()` carve-out, the proof gate (`bugflow check`),
   GitHub rulesets, the merge queue, CODEOWNERS, `.claude/loop.md`, and the skills that call into
   the CLI.

Claim resolution keeps the one mechanism from the legacy design that was already correct across
machines — `team.mjs`'s comment-CAS, lowest live server-assigned comment id wins, lease-time-based
expiry — and fixes only the identity string, from a bare worktree name to `login/host/worktree`.
Everything else about *how a claim is arbitrated* is unchanged; what changes is *where the record
that arbitration operates on lives*: GitHub's own comment/label/assignee API, not a file two
machines might both believe they alone are writing.

Full design: [`tools/bugflow/README.md`](../../tools/bugflow/README.md) and the documents it
indexes.

## Options considered

1. **Keep the bespoke registry and fix the two multi-machine defects.** Concretely: replace the
   lockdir mechanism with something arbitrated by a real server (GitHub comments/labels, or a
   hosted database) instead of a local directory, and change claim identity to
   `login/host/worktree`. *Pros:* smallest possible diff from what already exists; keeps 7,300
   lines of hand-tuned domain logic (`classify()`, wave colouring, the proof gate, a self-test
   suite) that already works for the single-machine case. *Cons:* the fix for defect 1 is not
   a patch, it is a rewrite — the moment the lock's authority moves off the local filesystem, the
   ledger is no longer "a plain git-tracked JSONL file guarded by a local lock," it is a
   distributed system, and building a distributed system's correctness properties by hand on top
   of git merge (which offers no row-level locking, no atomic compare-and-swap, no server-ordered
   anything) is exactly the hard problem GitHub's API already solves. And the code is now merged and
   live on `master` (PR #597, `10ddc3fa`) as Gate 4's own sync call and every session's registry
   writes — patching a design that is already load-bearing in production is a live migration with
   real callers to keep working, not a green-field rewrite; choosing the merged shape correctly now,
   before more machines depend on the current one, is cheaper than patching around live dependents
   later.
2. **beads / `bd`** — a Dolt-backed, git-native issue tracker: hash-based ids, `bd ready` for the
   takeable set, an atomic `--claim`, and `bd dolt push/pull` replicating a full relational database
   over `refs/dolt/data`. *Pros:* purpose-built for exactly this problem (a git-native queue an
   agent fleet claims against) and gets atomic claims for free in its embedded mode — but only
   **per machine**. *Cons:* embedded mode is single-writer per machine, which is the same class of
   problem this ADR exists to fix; atomic claims *across* machines require standing up a shared
   `dolt sql-server` — a new, persistent, self-hosted service to provision, back up, and secure, in
   a monorepo whose CLAUDE.md already forbids introducing a second stack lightly (Supabase, Vercel,
   a second HTTP client are all named "DO NOT introduce" for the same reason: operating a service
   this repo doesn't already run anywhere else). Since mid-2026 beads' JSONL representation is
   export-only, not the live store, so "law and record both live as plain text in the repo" and
   "atomic cross-machine claims" are not simultaneously available from beads — a project has to
   choose one, which is the exact trade-off GitHub's API resolves without a second service.
3. **A hosted tracker with agent assignment** (Linear's agent-assignment surface, or Jira).
   *Pros:* mature, purpose-built UX for exactly this — assign an issue to an agent, watch it work,
   review the result. *Cons:* rejected on cost (a per-seat license on top of the Claude
   subscription seats already paid for) and on "record on the repo" — the record would live in a
   third party's database, unreadable by `git log`, ungoverned by this repo's own rulesets and
   CODEOWNERS, and gone the day the subscription lapses. That directly contradicts the
   extractability goal: a package whose record lives in an external SaaS is not "move the repo,
   move the history" the way a GitHub-Issues-backed one is.
4. **GitHub Issues as the database (chosen).** *Pros:* already the repo's board — `team.mjs`
   proved the comment-CAS claim mechanism is cross-machine-correct today, on the free tier, with no
   new service to run. Native sub-issues, issue types, and blocked-by/blocking dependencies are
   already GA. Projects v2 is a dashboard the team already has open. The assign-issue→PR pattern is
   the same one GitHub's own Copilot coding agent ships. Zero new infrastructure — `gh` is already
   a dependency of every script in this repo's CI. *Cons:* GitHub Issues was not built as a
   programmatic bug-catalogue backend — a `## Files` list embedded in issue-body markdown is a
   weaker schema than a real table, mitigated here by the config-driven label/field convention
   documented in [DATA-MODEL](../../tools/bugflow/docs/DATA-MODEL.md); and a merge queue with
   required checks needs CI to actually run on the (mostly private) repo, which makes fixing GitHub
   Actions billing on private repos a real stage-1 prerequisite, not a nice-to-have (see the
   Consequences below and the existing public/private CI-window workaround in `CLAUDE.md` § Canonical
   deploy flow).

## Consequences

**Positive**

- The record becomes a real server-arbitrated resource — GitHub's comment ids, assignee field, and
  label API — so there is no local lockdir to design, no pid-liveness heuristic to get right, and
  no plain-text merge conflict on a state file to resolve by hand.
- Claim identity (`login/host/worktree`) disambiguates two developers with identically-named
  worktrees, which the legacy bare-worktree-name identity could not.
- The growth path to fleet seats (see [ROADMAP](../../tools/bugflow/docs/ROADMAP.md)) is native
  rather than retrofitted: every worker, present or future, is just another `gh`-authenticated
  identity making the same CLI calls.
- The core is extractable by construction — no RouteFlow import, all product knowledge in one
  config file — so the tool can leave this repo without a rewrite if it ever should.

**Negative / trade-offs**

- **Migration cost.** 212 existing bug records and 31 status shards — both now on `master` since PR
  #597 merged (`10ddc3fa`, 2026-09-05) — have to be imported into Issues/labels (`bugflow import`)
  rather than simply continuing to accrue — see [MIGRATION](../../tools/bugflow/docs/MIGRATION.md).
- **GitHub Actions billing on the mostly-private repo becomes a stage-1 prerequisite**, not
  optional polish — a merge queue and required checks need CI to actually execute, and today CI
  windows depend on the repo briefly flipping public (`docs/runbooks/deploy-visibility-flip.md`).
- **The wave-scheduling algorithm has to be ported, not merely referenced** — `bugs.mjs`'s
  `classify()`, its rank-then-greedy-colour wave assembly, and its hub-file exclusion rule are
  genuinely good and are being kept, but they move from operating on local JSONL shards to
  operating on GitHub labels, which is a real reimplementation even though the algorithm itself is
  unchanged.
- **Merge queue support on private repositories** needs confirming against the org's actual GitHub
  plan before `bugflow check` can be wired as a queue gate (see Open questions).

**Follow-ons**

- Fix GitHub Actions billing on the private repo (stage-1 prerequisite, named above).
- `VERIFY:` merge queue on private repositories may require a Team or Enterprise plan; confirm
  before depending on it in [GUARDRAILS](../../tools/bugflow/docs/GUARDRAILS.md).

## Compliance notes

- No live client identifier (slug, business name, product, order/invoice number, tenant UUID) may
  ever appear in an Issue title, body, comment, or label — Issue visibility follows repo
  visibility, so this is the same rule that already governs committed files, applied to a new
  place text can land. `privacy.denylistEnv` keeps the actual denylist out of the repo entirely.
- Money/tenancy/migration carve-out logic is preserved exactly, ported from `classify()` rather
  than redesigned — a false "sensitive" still costs a glance, a false "safe" still costs a
  production incident, and neither risk changes by moving where the label lives.
