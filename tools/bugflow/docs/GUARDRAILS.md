# Guardrails

**Status:** Proposed v0.1 · **Date:** 2026-09-04 · **Audience:** whoever configures GitHub rulesets
or CODEOWNERS for this repo, reviews a bugflow worker's PR, or is deciding whether to add a fleet seat

Routines and scheduled tasks run with **no permission prompts** — every guard below has to live in
the repo, in GitHub's own settings, or in the prompt itself, because there is no runtime "are you
sure?" to fall back on. This is the complete list: what each guard is, where it lives today versus
where it still needs to be built, and what it stops.

## The guards

**`classify()` carve-out.** Money, tenancy and migration patterns (regexes against a bug's title +
the joined `## Files` list — see the read-only `scripts/campaign/bugs.mjs`'s `SENSITIVE` table, on
master since #597; see MIGRATION Step 0 — the design bugflow's own `carveOut` config
key carries forward, widened from title+location to title+Files) force a bug to `parked` instead
of `ready`.
Parking survives until a human adds `approved:owner`; only then does it become `ready` (with
`harness:full`). Stops: an unattended worker touching money math, tenant scoping, or a migration
without a human ever having looked at the plan. Deliberately over-broad — a false "sensitive" costs
one glance, a false "safe" costs a production money bug, per the owner ruling this carries forward.

**GitHub rulesets.** Protected `master` (no direct pushes, from any account); required status checks;
merge queue; path-scoped required reviews for the carve-out paths — `**/pricing.ts` (today matches
four files: `apps/api/src/common/pricing.ts`, `apps/api/src/utils/pricing.ts`,
`apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts` — the glob's job is exactly to not need
updating when a mirror moves), `packages/pricing/**` (no such package exists yet — forward-looking,
for if pricing logic is ever extracted from the per-app mirrors), `apps/api/prisma/migrations/**`,
and a tenant-guard path. `VERIFY:` the exact tenant-guard glob(s) — the brief does not name one, and
no CODEOWNERS-equivalent exists in this repo today to infer it from (confirmed: no `CODEOWNERS` file
here as of this writing). None of this exists yet; it is Stage 1 work (see
[ROADMAP.md](ROADMAP.md)), and its required-checks half is blocked on the Actions-billing
prerequisite below.

**CODEOWNERS.** Does not exist in this repo today. Needed at minimum for the carve-out paths above,
so a required review actually routes to someone qualified rather than to whoever GitHub picks.
Recommended (not yet an owner decision — `VERIFY`): also cover `bugflow.config.json` itself,
specifically its `carveOut`/`seats`/`labels` keys — those ARE the safety mechanism, and no worker
should be able to widen its own carve-out unreviewed, the same shape as an established lesson here
(never edit outside a batch's declared scope without surfacing it).

**The proof gate (`bugflow check` in CI).** A required check: every `Closes #N` on an issue of type
Bug must have a `REG-#N` proof **present**, by tier — and, for `tier:t1` only, **passing**, not
merely present. This mirrors `campaign-check.mjs`'s existing contract for the in-repo registry,
including its hardest lesson, worth carrying forward explicitly: a missing test-report artifact
must fail the gate, never pass it silently — the read-only source's own header names exactly this
failure mode ("tool missing" and "no proofs found" must never look the same). A `tier:t2`/`t3`
proof (Playwright against a deployed build; a manual verification row) genuinely cannot exist before
merge — `campaign-check.mjs` handles this with a distinct `proven-pending-deploy` ledger state;
[LIFECYCLE.md](LIFECYCLE.md) instead folds it into `verifying` with no separate status (tier tells
`bugflow verify` which check to run post-deploy). The tension that fold used to leave open is
resolved: `check`'s merge-time gate is present-per-tier, passing-only-for-`tier:t1` — never "PR
merged AND passing" for every tier — so a `tier:t2`/`t3` bug satisfies it with `prove`'s proof comment
showing the token present in the diff, and only the later `verifying → done` transition demands
the passing post-deploy result.

**Stop-hook gates (`.claude/hooks/stop.mjs`).** Confirmed by reading the file directly on `master`:
**Gate 1** (formatting) and **Gate 2** (code-map freshness) apply to any change; **Gate 3** (a lesson
recorded after a bug fix) blocks a `fix/*` branch, or a landed `fix:` commit, with no
`.claude/lessons/` change since. **Gate 4 exists on `master` today**, merged by PR #597
(`10ddc3fa`, 2026-09-05): "Gate 4: bug-registry sync (reports, never blocks)" runs a non-blocking
`bugs.mjs sync` on every session, on every branch — there is no longer a branch that gets no Gate 4.
Bugflow's own stop-hook integration (a reporting-only `bugflow sync --quiet`, on the same
non-blocking model) is still new work, not yet landed anywhere — see [MIGRATION.md](MIGRATION.md)
for how, at cut-over, Gate 4's call target simply flips from `bugs.mjs sync` to
`bugflow sync --quiet`; bugflow follows the existing gate rather than superseding the hook itself.

**Privacy — no live-client identifiers.** The denylist itself is never in the repo
(`privacy.denylistEnv` reads it from an environment variable / private source at `sync` time). This
is the sharpest edge in the whole design: unlike `.claude/lessons/LESSONS.md` (a tracked file,
reviewed in a PR diff before it can leak), a GitHub Issue can be written directly by an unattended
Routine or task with **no review step** before the repo's next public CI window. The `sync`-time
denylist check is the only thing standing between an unattended worker and a client identifier
landing in an issue body, a comment, or a commit message. It must redact-and-flag, never
redact-and-silently-continue.

**Public-window exposure + the Actions-billing prerequisite.** Merge queue and required checks need
CI to actually run on the private repo. Today it only reliably does during the manual
public→CI→private window (`CLAUDE.md` § Canonical deploy flow) — Actions billing on this repo breaks
while private. A human-initiated deploy hits that window once per release; a bugflow fleet running
every 5 minutes would need it **per PR**, which is either a public window running continuously
(unacceptable) or CI that simply does not run (defeating required checks entirely). This is why
fixing Actions billing on private is a named Stage 1 prerequisite, not a nice-to-have — everything
downstream (merge queue, required checks, the proof gate as a required check) is unusable without
it. Until it's fixed, the existing visibility-watchdog mitigation (a detached process with a fixed
deadline, armed **before** the public flip — see the project's own lesson on this exact failure
mode) becomes load-bearing at much higher frequency than today's occasional manual deploy.

**Routine permission model.** Zero prompts, ever — so the only controls are which repos/connectors a
Routine is attached to, what environment it's given, and what its own prompt says to do. That makes
[`../templates/routine-housekeeping.md`](../templates/routine-housekeeping.md) and
[`../templates/routine-triage.md`](../templates/routine-triage.md) themselves a security boundary,
not merely documentation: they must state their scope explicitly (only bugflow commands, only this
repo, pushes only to `claude/`-prefixed branches) because nothing else will catch a scope violation
before it happens.

**Secrets.** None live in bugflow. `gh` auth is per-seat — whichever account is logged into that
machine or Routine. The privacy denylist is an environment variable, never a committed file.

**What a fleet seat is, and may / may not do.** A fleet seat is a GitHub **machine-user account
owned by the org** (`VERIFY:` GitHub ToS on machine users — separate from whether the Claude Code
plan supports the seat itself, which it does) on its own Claude Code Team seat — never a real
developer's personal login pressed into unattended service. May: claim and work `agent-safe` bugs
up to its own `dailyClaimCap`; open PRs; comment; heartbeat and release its own leases. May not:
touch a `parked` bug without `approved:owner`; push directly to `master` (rulesets block this
regardless of account); edit `bugflow.config.json`'s own carve-out/seat definitions (recommended
CODEOWNERS scope above); **approve any PR, including its own** — a fleet seat is excluded from
CODEOWNERS and from every required-review rule by design, not merely by GitHub's own "can't
approve your own PR" default.

## Attack / mistake table

| Scenario | What actually stops it | Residual risk |
|---|---|---|
| Someone hand-moves a card / hand-edits a `status:` label | `sync` is idempotent and **derives** status from PR/CI/deploy/blocker/lease facts every tick — a hand-set label is simply overwritten on the next housekeeping tick | Up to an hour of a wrong-looking board before the next tick; `sync` also flags a hand-set **assignee** with no matching lease comment — on a `ready` bug it removes the assignee and comments, on a `parked` bug it comments and adds `needs:human` (both never silently accepted) |
| A Routine pushes to `master` | Two independent layers: the GitHub ruleset rejects any direct push regardless of account, and Cloud Routines are separately documented to accept pushes only to `claude/`-prefixed branches, rejecting protected branches at the platform level | A Desktop-task worker is a full local git session with no such platform-level restriction — it relies entirely on the repo ruleset existing and being correctly configured |
| An agent claims a `parked` bug | "Takeable" excludes `parked` by definition; a well-behaved `bugflow claim` refuses it (exit 4) | GitHub's own assignee field has no concept of bugflow's state machine — a worker that hand-assigns via `gh issue edit --add-assignee` instead of `bugflow claim` bypasses the check entirely. `sync` catches this after the fact (row above) and comments + `needs:human` on a `parked` bug specifically |
| A PR closes a bug with no `REG-#N` test | The proof gate (`bugflow check`) as a required check | A gate strict enough to always block `tier:t2`/`t3` (which cannot prove pre-merge) creates pressure to disable it outright — the provisional-state escape hatch above exists specifically to avoid that trade |
| Usage runaway | Per-run caps (one batch, ≤ 8 iterations, ≤ 45 min) bound any single invocation; skip-if-still-running bounds back-to-back pileup on one seat | Nothing here bounds the **aggregate** across seats — every dev's task, the fleet seat, and a Routine could all be iterating at once on a day every `dailyClaimCap` happens to be raised together. `VERIFY` whether an org/repo-wide daily ceiling is needed, given "disable Routines org-wide" is the only global kill-switch the brief names |

## Open questions

- `VERIFY:` exact tenant-guard path(s) for the required-review ruleset.
- `VERIFY:` whether `bugflow.config.json`'s safety keys get CODEOWNERS protection (recommended
  above, not yet an owner decision).
- `VERIFY:` an org/repo-wide daily spend or run ceiling, beyond the per-seat `dailyClaimCap`.

Gate 4 already landed on `master` via PR #597 (`10ddc3fa`); bugflow's stop-hook integration
*follows* Gate 4 rather than superseding it (see [MIGRATION.md](MIGRATION.md) Step 4).
