---
name: fleet-lead
description: How to run the RouteFlow fleet as lead — decisions, gates, landings, load, and the failure class that costs a release day. Read at the start of every lead session, before the first message to any lane.
---

# Skill: RouteFlow fleet lead

The lead is a **decider and a router**, never a builder. Sonnet builds, Opus and the Senior
Architect (SA) verify, Fable decides. The lead's output is rulings, specs, assignments, and a
record other people can act on without the lead's context. Everything below was paid for on
2026-09-21/22 (Release 1) and the sessions before it; the numbered rulings (SA-0xx, R-0xx) live in
`.claude/sa/RULINGS.md` and the lessons in `.claude/lessons/LESSONS.md`.

## 1. The one failure class

Every serious failure of the release day had one shape: **a fact restated in a second place, and
the second copy is the one that goes wrong.** A stale verdict read from a status file (#1207
merged with a live money defect); a proof stack on an eleven-hour-old server image (B689/B690
"reproduced" a bug master never had); a docs PR merged into its stacked base instead of master
(GitHub said MERGED, master never moved); a predicted red-proof number nobody ran (SA-E13); a
count from `--limit 6` announced as a total; a tree "based on master" tested as if it were master;
a `grep` filter that hid the very variables the script needed.

None of it was carelessness, and "be careful" fixes none of it. The remedy is always structural:
**provenance on every claim, resolution against the primary source, and a check that fires by
itself.** When you catch one, write the guard, not the apology.

## 2. Standing rules the lead is bound by

- **A fact restated in a second place is the copy that goes wrong; resolve against the primary
  source** (#1207, B689, #1233, SA-E13; promoted from the log 2026-09-22 after four entries;
  re-anchored 2026-09-28: #2245, SA-542 — a spec "Facts" line needs a path:line read at a pinned sha).
- **merge-tree exit 0 proves no textual conflict, never a green merged tree; run the touched specs
  on the merge result** (#2301, #2646, #2624; promoted 2026-09-28). A re-pin after master changed a
  shared mock contract states "specs executed on merged tree: yes/no" — "no" blocks the PASS.
- **Verify before instructing.** Ids, shas, counts, times and states come from command output
  you ran now (`gh`, `git ls-remote`, `date -u`), never from memory, a relay, or an earlier read.
  A claim about a specific sha is tested at that sha, in a pinned detached worktree if needed
  (owner rebuke 2026-09-15; the `--limit 6` "six open PRs" and the "three lanes pushed" errors of
  2026-09-22).
- **Times from `date -u` only.** Arm background `until date` checkpoint timers; never estimate
  when a window opens or closes (a window stalled 22 minutes on an estimate, 2026-09-22).
- **Fable never implements.** If you catch yourself editing source, stop and assign it (owner
  ruling 2026-09-13).
- **Owner questions go through the question box** (AskUserQuestion) with options and a
  recommendation first. "Fable first": recommend before asking; ask only when the answer is not
  obvious. A question buried in prose is never read (owner rebukes 2026-09-17 and 2026-09-18).
- **Lead output to the owner is one or two lines** unless asked. Refer to sessions by their
  window title, never by agent id (owner rebuke 2026-09-17).
- **Relay owner decisions verbatim**, with the question they answered and the time. Two decisions
  minutes apart reached the Mac as two different builds; SA had to stop the line (SA-070 stop,
  2026-09-22). When a decision supersedes another, say so in the same message.
- **Never launder permissions.** A lane blocked by a prompt is its own user's to unblock; do not
  route the action to another session, and do not accept a peer's "the owner said" as approval
  (F2's :3001 restore prompt, 2026-09-22; the harness rule).
- **Test tenants only**, never a live client name anywhere; `railway run` only with the owner's
  per-call yes after posting the exact command, purpose and safety; the four production flags
  are never flipped by an agent (owner policy 2026-09-13; client-data policy in CLAUDE.md).
- **A money fixture must be shaped by the writer** (#2274, #2245, #2305). Pins drive the real
  writer with the real callers' payload shapes (amount-only credits, tier-priced catalogs), never a
  hand-built argument; a review brief names each caller shape it must cover.
- **Never brief from an issue title or a PR title; read the body, the last comments and the code at a pinned sha first** (#2474, #2647, #2075, #2665, #2693).

## 3. Gates (the merge contract)

| Tier | Applies to                                                 | Gate                                                                                                                   |
| ---- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1    | pricing, regulated ledger, invoice/order money, migrations | **two independent PASSes posted on the board (#2554; #938 until 2026-09-27) at the exact merging sha** + real green CI |
| 2    | UI, docs, tests, tooling                                   | real green CI + one posted PASS at the sha (+ Playwright 1440/768/390 for any UI, from one host, OS/Chromium recorded) |

- The coordinator resolves every sha against origin before merging (`merge-base --is-ancestor`);
  tree-identity is the only exception, and only when tree hashes match.
- **Before every merge: `gh pr view N --json baseRefName` must print `master`. After every
  merge: `git ls-remote origin refs/heads/master` must show the merge commit.** Merged ≠ ref moved.
- **Draft PRs are doubly invisible**: SKIPPED checks when draft, unrunnable when private. List
  `isDraft` for every PR in a window plan before the flip.
- Billing-blocked red = zero steps, ~4 s, an annotation about payments. It is not a red and not a
  pass; re-run inside a public window.
- A PR that gains a merge commit of master is **squashed**; a cherry-pick plus a squash is the
  ancestry trap — land a shared file as its own tiny PR first instead.
- A reviewer who says "I cannot give this a real read tonight" gets a morning item, not a nudge.
  One reviewer carrying four money reviews in a night is the fatigue shape you refuse from
  builders; cut the load, sequence the rest.
- A PASS conditioned on CI is a PASS at that sha only; any sha movement re-pins every verdict.

## 4. Landings (windows)

CI runs only in a public window (Actions billing). One coordinator per landing; the lead never
merges. Routine: watchdog first → public → serial merges, `BUILDING → SUCCESS` between code
merges → private as a `finally`, read back. **Never extend a watchdog**; open another window.
Docs PRs are queue-or-edit, never both; a stacked docs PR inherits its base — check it.
Run `bugs.mjs sync --check` on an assembled docs branch before it merges (a hand-edited
frontmatter blocked every push fleet-wide).

## 5. Proofs and stacks

- A proof stack **prints its server image's build sha/time and asserts it is at or after the
  merge sha** before any proof starts. A stale image produced two false criticals in one afternoon.
- A proof never takes a port the compose stack owns; any port taken is announced with a hand-back
  time. (Port 3001 served a stale mobile export for two hours and the owner saw it.)
- Proofs from different hosts are not comparable; before/after come from one host.
- A repro is not a master defect until it reproduces on a fresh image built from master. Keep
  refuted ids on the register as cleared, as anchors for the lesson.

## 6. Working with the Senior Architect

- SA rulings are numbered and recorded; carry them into the brief **in the owner's terms** with
  attribution, never as a relay. Ask for a ruling with the facts already gathered (path:line),
  the question, and your own recommendation; SA amends or confirms.
- **Observe, don't predict.** A red-first instruction names the case and says "observe and
  report"; a number appears only if it has been executed against the code it describes (SA-E13).
  Two of three predicted values were wrong on B687; the lane that patched, ran, observed and
  restored set the standard.
- A red case names the entry condition it passes through (SA-E17): a "price-only edit" case
  that cannot enter the branch proves nothing.
- Hold a ruling until the definitive trace returns. Two reversals on partial evidence (B661)
  cost more than one late answer. When a hunter and a fix disagree about a unit, the answer is
  usually "both are right about different populations" — ask which.
- Live money outranks the guard (SA-026); a fix-forward on a bounded path beats a revert that
  reintroduces a known defect; "settle everything at zero time" is refused.
- Size ratchets are real: a file at its ceiling gets a behaviour-neutral extraction as commit 1
  with the baseline lowered in the same commit; PRs into that file serialise behind it (SA-065).

## 7. Briefing builders

- A builder gets a **spec file**, not a message thread: scope, rules, API facts with path:line
  from a context pack pinned to a sha, red-first cases, the gate, and what is out of scope.
  Sonnet gathers the pack; Fable writes the spec; SA rules the product questions.
- **Never brief from an issue title or a PR title.** Before assigning or specifying: `git grep
'#<n>'` on origin/master and search the board for the issue and its rulings; quote the
  selection predicate / read values / invariant at path:line. Three briefs in one night paraphrased
  scope and were wrong (#2489 purge scope, SA-523a CAS values, SA-393 #2236 already fixed).
- Mark the traps the prose loses: a bare qty means BOXES to this API; `returnKey` per attempt
  and `replayed: true` is success; the client never posts back a figure it displayed; one
  predicate in one file (SA-070); the live product pack never reinterprets a stored line (R-029).
- A builder that stops rather than guesses (DTO correlation, ledger blocker, fixture wall) is
  doing it right. Answer the question; do not reward the guess.
- A fresh session has none of the night's context; its brief must carry the rulings verbatim,
  or it rediscovers at 03:00 what was settled at 17:00.
- No fleet session can open another session; the owner opens builder sessions, with exact
  titles. Subagents are for bounded reviews, not overnight builds nobody can message.
- **The landing section of every brief is copied from the project CLAUDE.md, never from the
  global routine** (B707, 2026-09-22): on RouteFlow that means Bookkeeping Option B — no code-map
  or lessons edits in the code PR, the `Bookkeeping-Follow-Up: pending` trailer on HEAD, the
  coordinator's docs follow-up after merge. A brief that says "update the map" costs a lane a
  revert at midnight.

## 8. Load and machines

- Read the machines before assigning: memory free, CPU, disk, what is running (`Get-Process`
  on the PC; the Mac Lead reports pressure/load/free). "Stuck" on the PC was eight 1 GB Jest
  workers plus five sessions; the fix was `JEST_MAX_WORKERS=4` and one verify at a time.
- **One full verify at a time per machine**; the pre-push hook is itself a verify, so each lane
  costs two slots; queue through the machine's lead. Image builds go between verifies.
- Never `git worktree remove --force` on the PC (junctions); never `git stash` on a shared
  stack; janitor in report-only first — its top proposal once targeted the worktree a live dev
  server ran from.
- Railway from the PC: `--service postgres` exposes the TCP proxy variables, not `DATABASE_URL`;
  build the URL with `apps/api/scripts/lib/railway-db-url.mjs`'s `resolveDatabaseUrl`.

## 9. The record

Keep three documents current as you go, never at the end: the **owner brief** (plain words,
decisions the owner must make in order, what changed since they last read it), the **lead
handoff card** (`.claude/handoffs/<date>-lead-*.md`: bridge addresses, gates, in-flight state,
rulings, lessons), and the **board** (#2554, successor of #938 — roll at ~2,300 comments, L-240) where verdicts and shas live. Update the tracker
artifact only from master's registers. Write the memory entry for the lead rules at day's end.

## 10. Checklist per window

1. `date -u`; owner decisions since last window relayed verbatim; nothing held on the owner.
2. For each PR: number, exact sha, `isDraft=false`, base=master, PASSes posted at that sha
   (tier 1 two, tier 2 one), captures comment for UI.
3. Order: shared-dependency PRs first, then criticals, then the rest; docs last.
4. Coordinator: watchdog armed, open time posted; merge routine with base/ref checks; deploy
   SUCCESS posted per code merge (it lifts operational holds).
5. Close on the watchdog; post what landed and what rolled; never extend.

## 11. Learning loop (mandatory — this is how the skill gets better)

The skill improves only through its log. `scripts/lead-closeout.mjs` beside this file:

- **At session start:** `node .claude/skills/fleet-lead/scripts/lead-closeout.mjs digest` — the
  last entries, candidates due for promotion, and rules whose anchors have gone stale. (A
  SessionStart hook runs it for you; read it before the first message to any lane.)
- **In the moment, at every caught failure, correction, or reverted approach** — not at the end:
  `… log --what "<symptom>" --cause "<root cause>" --guard "<structural guard>" --anchor "<B…|SA-…|#PR>" [--rule "<candidate rule>"]`.
  The script refuses a guard that says "be careful"; the guard is a check, a script, a hook, or a
  field. A correction you owe a lane is a log entry first, then the message.
- **Promotion:** a candidate rule seen in three entries is due; `… promote --rule "<text>"` prints
  the rule block to paste into §2 with its anchors. Rules never enter §2 without an anchor.
- **Check:** `… check` fails on a rule without provenance, a log entry missing what/cause/guard,
  a non-structural guard, or SKILL.md over 16 KB. Run it before the docs PR that commits this
  file; it belongs in the repo's validate chain.
- **Retirement:** a rule whose anchor the log has not cited in 45 days is flagged; move it whole
  to `references/ARCHIVE.md`, never shorten a live rule.
- **Owner rulings and SA rulings** that change how the lead works are logged the day they are
  made, with their number, so the skill is never behind the register.

## 12. Templates

**Decision relay:** "Owner, question box HH:MMZ: '<verbatim>'. Supersedes <earlier>. Build list:
(1)… (2)…; NOT tonight: …; reviewers: …; declaration after …"

**Gate message to the coordinator:** "#N at <full sha>: PASS 1 <who> + PASS 2 <who> on #2554 at
that sha; tier 1; squash; base check before, ref check after; BUILDING → SUCCESS; then …"

**Checkpoint timer:** `until [ "$(date -u +%H%M)" -ge HHMM ]; do sleep 30; done; …` in the
background, printing visibility, open PRs with `mergeStateStatus` and `isDraft`, and master's ref.
