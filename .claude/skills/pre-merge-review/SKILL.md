---
name: pre-merge-review
description: Independent, adversarial review that every PR must pass BEFORE it enters a merge window — plus the bounded fix loop when it fails. Use before merging anything to master, when the lead fills block A, when a PR reports "ready", or when the user says "review before merge", "pre-merge", "is this safe to merge". Not a substitute for a lane's own in-lane review; it is the second, independent gate that catches what an embedded reviewer structurally cannot see.
---

# Pre-merge review — the independent gate

**Owner ruling 2026-09-13: every change is reviewed independently before merge.** Same day,
evidence for why: PR #710 had passed **three** in-lane Opus refute rounds and full CI, and read
READY; one independent pass found a money seam (two halves of a door quote fed from
differently-filtered line sets — drivers over-collecting cash). PR #711 read READY and carried
1,012 lines of engine scratch at the repo root and 19 commits authored by a test identity, about
to land on a public master. Neither lane could see its own blind spot. This gate exists for that.

## Model routing (owner ruling 2026-09-13 — Fable never implements)

| Step | Model · effort | Why |
|---|---|---|
| Hygiene pre-check | **Haiku** · low | mechanical: authorship, root scratch, secrets, client ids |
| Independent verdict | **Opus** · high | a verdict over a compact input; the tier that has been catching seams |
| Fix (if BLOCK) | **Sonnet** · medium | the lane's own executor writes the fix from a design |
| Fix design (if non-obvious) | **Opus** · high | what to write |
| Re-review of the delta | **Opus** · high | delta only, never the whole PR again |
| Docs-only PRs | lead reads the diff | an adversarial pass on docs is theatre |

Never Fable for any step. Never the lane's own in-lane reviewer for the verdict — independence
is the entire point.

## Procedure

### 0. Scope the PR
`gh pr view <n> --json headRefName,changedFiles,additions,deletions,isDraft,mergeable`. Locate the
worktree that holds the branch (`git worktree list`). **Read-only** on that worktree — `git -C <path>`,
never `cd` into another session's tree.

- **Docs-only** (no `apps/`, `packages/`, `scripts/`, `.github/`): the lead reads
  `git -C <wt> diff master...HEAD --stat` and the diff itself, records CLEAN, done. No agent.
- **Code**: continue.

### 1. Hygiene pre-check (Haiku, or the lead by hand — ≤ 2 minutes)
These are the cheap, mechanical things that were about to reach a public master on 2026-09-13:
- **Authorship**: `git -C <wt> log origin/master..HEAD --format='%ae' | sort | uniq -c`. Any
  address that is not the pinned identity is a BLOCK (a test identity on public history).
  Check the *repo-level* config too: `git -C <repo> config --show-origin user.email` — a
  repo-local override poisons every worktree at once.
- **Scratch at the repo root**: `git -C <wt> diff master...HEAD --name-only | grep -vE '^(apps|packages|scripts|docs|\.claude|\.github)/'`
  — engine artifacts (`build-plan.md`, `cause-brief.md`, …) written to cwd instead of the run dir.
- **Secrets / client identifiers**: the repo goes public for CI. Grep the diff for connection
  strings, tokens, and any live client slug or business name (approved test tenants only:
  `test`, `e2e-routeflow`, `routeflow-demo`, `qa-*`, `e2e-*`, `ux-audit-*`).
- **Migration present?** If `apps/api/prisma/migrations/` changed: this PR needs the owner's
  prod-migrate window and the drift gate; flag it on the queue row.

### 2. Build the reviewer's brief — this is where the value is
The reviewer must be told **what an embedded reviewer could not see.** A generic "review this"
re-finds what the lane already found. Always include:

1. **Provenance and risk profile.** Who/what produced it (hand, engine, resumed engine). What
   review it already had (e.g. "three in-lane Opus rounds"). Known incidents on this branch
   (e.g. "the engine reported complete over five red tests"; "a test was mutated to match the
   implementation and restored by hand"). Late hand-patches that never went through a loop.
2. **The invariant the batch exists to protect**, stated as a sentence. The reviewer verifies
   *that*, not the diff's self-description.
3. **Required explicit yes/no answers** (pick the ones that apply; always the first two):
   - Did you find any **weakened assertion** — a looser `expect`, a deleted test, an exact
     match turned `objectContaining`, a case renamed away?
   - Can any **money write double-apply** on retry/offline replay?
   - Is every new/changed query **tenant-scoped** (`forTenant()` / `tenantTransaction`; the
     tenant proxy scopes only the top-level model — nested relation filters are not scoped)?
   - Any **locally redeclared enum/shape** instead of `@routeflow/types` (lesson L-072)?
   - Any money math outside `@routeflow/pricing`, any `qty * unitPrice` on a boxed line?
   - A **second lock** layered on `withAdvisoryLock`, or a transaction threaded into
     `updateOrderItems`?
   - For a seam: are the two halves of any computed amount fed from **the same filtered set**?
4. **Scope discipline for the reviewer**: hard cap ~12 tool calls; work from the diff and the
   files it touches; no repo-wide exploration; no style/formatting findings; report only what
   would hold the merge or that an approver must know.
5. **Return contract**: `VERDICT: BLOCK | MERGE-WITH-NOTES | CLEAN`, each finding as
   `file:line — concrete failure scenario (inputs → wrong outcome) — why it matters — confidence`,
   plus the required yes/no answers stated explicitly. Under ~600 words.

Template: [reviewer-brief.md](reviewer-brief.md).

### 3. Dispatch
One `Agent` call, `model: opus`, `effort: high`, `subagent_type: general-purpose`, the brief
above. **Never the lane's own session**, never a reviewer that already reviewed this branch.
Two PRs → two agents in one message, in parallel.

### 4. Record the verdict where merges are decided
Write it on the PR's row in the merge queue (`local-assets/handoff/<date>/MERGE-QUEUE.md`):
verdict, the blocking findings verbatim-short, owner lane, required answers. A **BLOCK removes
the PR from block A** until cleared. MERGE-WITH-NOTES stays in block A only if the notes are
hygiene the owner lane clears before the window; otherwise it is a BLOCK.

### 5. Fix loop (bounded)
- The **owning lane** fixes it — red-first test for the finding, Sonnet fix, **one** in-lane
  Opus refute of the delta. Not the reviewer, not the lead.
- Then the lead dispatches an **independent re-review of the delta only** (`git diff
  <verdict-sha>..HEAD`), same model, a brief that quotes the original finding and asks: is it
  closed, and did the fix introduce anything? Never re-review the whole PR.
- **Two rounds maximum.** A PR still BLOCKED after two independent rounds is escalated to the
  owner with both verdicts side by side — not merged, not silently re-reviewed a third time.
- Hygiene BLOCKs (authorship, root scratch) are cleared by the lane with a rebase and **one**
  force-push (a branch push is not a merge and is not covered by any merge freeze); re-verify
  with the step-1 commands, no agent needed.

### 6. Gate semantics
- No PR enters block A without a recorded verdict of CLEAN or cleared MERGE-WITH-NOTES.
- A verdict is per-HEAD. New commits after the verdict → re-review the delta.
- The independent pass **replaces** in-lane rounds 2 and 3, it does not add to them: the
  house standard is one in-lane refute + one independent verdict. Four Opus passes where two do
  better is the cost the owner cut on 2026-09-13.

## What this skill deliberately is not
- Not a code-style review. Not a place to file nitpicks.
- Not a replacement for the lane's red-first tests or its one in-lane refute.
- Not a third or fourth review round — if a PR keeps failing, the lane's design is wrong, and
  that is the owner's call.

## Learning clause
After every BLOCK that reaches production-adjacent code, append one line to
`references/CATCHES.md`: date, PR, the class of defect, why in-lane review missed it. That file
is how the brief in step 2 gets sharper; a catch that leaves no record teaches nothing.
