---
name: lessons-learned
description: >
  Maintain and consult a per-project lessons-learned register under `.claude/lessons/` —
  generalizable rules distilled from bug fixes and surprising failures, so no mistake is paid
  for twice. Auto-load at the start of any major task, implementation, or bug fix (consult
  first), right after fixing a bug (record the lesson), and when bootstrapping a project
  without one. Keywords: "lessons learned", "record a lesson", "post-mortem", "postmortem",
  "retro" (the per-bug Record only — the cross-run ten-run cadence is /retro), "what did we
  learn", "why did this break again", "recurring bug", "never again".
---

# Skill: Lessons Learned

A **lessons-learned register** is a durable, capped list of *generalizable rules* a project has
paid for — kept at `.claude/lessons/`, in-repo so it travels with the repo (unlike the
per-profile memory dir). It exists so the same mistake is never debugged twice: read it before
major work, append after every bug fix.

Format: a PMI-style register (id / date / category / lesson / guard), blameless-postmortem
discipline (name causes not people; every lesson wants a guard), 5-Whys depth — a ≤ 6-line
entry so the register stays one cheap read.

Five workflows: **Consult**, **Record** (after every bug fix), **Compact** (enforce the caps),
**Digest** (regenerate the skim-first summary), **Bootstrap** (create it for a project).

## The artifact — `.claude/lessons/`

- **`LESSONS.md`** — the register. **Hard caps: ≤ 40 active entries, ≤ the project's
  `_meta.json.maxBytes` (default 40,960 bytes)** (target ≤ 30 after compaction — §3). The caps are
  justified by **context rot, not budget**: a register a session re-reads at every task start
  degrades the model's attention across its whole context as it grows, independent of how many
  tokens remain — so the cap holds even on a session with tokens to spare. Entries
  grouped under category headings — `process · tooling ·
  testing · deploy · domain · security · perf` — newest first within a category. Heading must
  be **exactly** `### L-NNN · <date> · <category>[ · <ref>]` (a validator matches entries with
  `/^### (L-(\d+))\b/` — a bare `L-017` in prose or a different heading level doesn't count).
  Schema:

  ```markdown
  ### L-017 · 2026-08-31 · deploy · #565
  - **Symptom:** first native APK run spun forever on launch.
  - **Root cause:** native keystore rejects `:` in keys; token writes silently failed.
  - **Lesson:** **Native storage validates key charsets web storage never did — test the
    first real device run, not just the bundler.**
  - **Guard:** key sanitizer + regression test (#565).
  ```

  **Lesson** is the payload — Reflexion framing: write it as what you would tell yourself right
  before doing this again, not as a description of what happened. **Root cause** and **Lesson**
  together must name the approach that was tried and abandoned (ExpeL contrast) — a lesson that
  states only the fix, without what stopped working, gives the next session nothing to act
  differently on. **Guard** names what prevents recurrence (test/hook/CI gate/doc) — or
  `none — judgment`.

- **`LESSONS-DIGEST.md`** (generated — never hand-edit) — one `- L-NNN · <category> · <Lesson
  sentence>` line per entry, no Symptom/Root cause/Guard. **Read this first, before
  `LESSONS.md`:** skim all active rules in a fraction of the register's size, then open the
  full entry for an id carried into a plan. Made by `validate-lessons.mjs --digest` (§4) —
  target ≤ 6,000 bytes once compacted to ≤ 30 entries, hard cap 12,000 bytes.

- **`ARCHIVE.md`** — append-only overflow; superseded/aged/guarded entries move here verbatim.
  Not read by default.

- **`_meta.json`** — `{ nextId, activeCount, archivedCount, maxEntries, maxBytes, updatedAt,
  schemaVersion }`. Bookkeeping ONLY — never accumulate prose here (an unbounded notes field
  elsewhere once grew to ~90K chars, ~38K tokens/read). `nextId` sits above every id ever issued
  (archived ids retire, never reissue); `activeCount`/`archivedCount` must equal the heading
  counts in `LESSONS.md`/`ARCHIVE.md` — checked by validator, since a git union-merge can leave
  both sides' counts individually correct and the total wrong; `maxEntries`/`maxBytes` are the
  caps as data (raising one is a field edit); `updatedAt` doubles as the enforcement hook's
  acknowledge-without-entry escape.

## 1. Consult — before major work

At the start of any major task, implementation, or bug fix:

1. **Read `LESSONS-DIGEST.md` first** if it exists (skip `ARCHIVE.md` always) — cheaper than the
   full register — **alongside the user's auto-memory index**
   (`~/.claude/projects/<project>/memory/MEMORY.md`, when present): the register holds
   rules this project paid for; the memory index holds cross-session facts about this project and
   its people. Read both at task start, cite whichever applies. Missing project → offer to
   **Bootstrap** (§5); digest missing/stale → read `LESSONS.md` directly and regenerate the digest
   (§4).
2. Skim the categories the task touches: deploy/release → `deploy` + `process`; a new feature →
   `domain` + `testing`; dependency/CI work → `tooling`; auth/tenancy → `security`. Carry the
   matching **Lesson** lines into the plan.
3. Open the full entry in `LESSONS.md` only for an id actually carried into the plan.
4. If a lesson changes the approach, say so — cite the entry id (e.g. "per L-009 …").

## 2. Record — after every bug fix

**Trigger:** you fixed a bug (`fix:`-typed change), reverted an approach, or were surprised by a
failure. Recording the lesson finishes the fix, like updating a test.

1. Find the root cause one level past the proximate cause — ask "why" until the answer is a
   *system property* (a missing guard, a wrong assumption class), not an event.
2. Append an entry under the right category: next `L-NNN` from `_meta.json.nextId`, today's
   date, category, PR/commit ref, then Symptom / Root cause / **Lesson** / Guard.
3. Bump `_meta.json` (`nextId`, `activeCount`, `updatedAt`) and regenerate `LESSONS-DIGEST.md`
   (§4) so it doesn't fall behind the register.
4. No transferable lesson (typo-class)? Bump only `updatedAt` — never force a junk entry.
5. **Land the entry in the same PR/commit as the fix**, not a follow-up. A
   `Bookkeeping-Follow-Up: pending` trailer is for public-window deploys only.

A pipeline's `closeout.mjs` enforces #5 mechanically on bugfix runs: it appends the stub itself
and **refuses to close out** (non-zero exit) when the register is at `maxEntries`/the byte cap,
printing "archive one entry for headroom, then re-run" instead of overshooting. Compact (§3)
first, then re-run.

## 3. Compact — when the caps are hit

When `LESSONS.md` exceeds 40 entries / the project's `_meta.json.maxBytes` (default 40,960
bytes) (or `closeout.mjs` refuses), move entries to
`ARCHIVE.md` verbatim rather than trimming `LESSONS.md` in place. The installed `consolidate-memory`
skill is the compaction helper here — the same archive-verbatim discipline it applies to auto-memory
files, run against this register:

1. **Prefer, in order:** (a) an entry superseded by a newer one, (b) an entry with a hard guard
   (test/hook/CI gate) that nothing still cites, (c) oldest with no recurrence/citations. Test
   for (b): not "does it have a guard" but "does the guard make the entry safe to stop reading."
2. **ACE anti-brevity — withdraws "merge instead of archiving" (owner ruling 2026-09-10).** Archive
   a whole entry to `ARCHIVE.md` verbatim; never paraphrase-shrink or merge a live one to make
   room. A shortened or combined lesson silently loses the exact condition that made it fire —
   compaction moves entries out intact or it does not compact them at all.
3. **Target ≤ 30 active entries**, not just under the 40 cap — that headroom keeps a normal bug
   fix from tripping the §2 refusal on its very next run.
4. Update `activeCount`/`archivedCount`, never renumber/reuse ids, regenerate
   `LESSONS-DIGEST.md` (§4).

## 4. Digest — regenerate after every register change

`LESSONS-DIGEST.md` is generated, never hand-edited. Run `validate-lessons.mjs --digest` after
any Record (§2) or Compact (§3): it turns each `### L-NNN` entry's **Lesson** bullet into one
`- L-NNN · <category> · <sentence>` line, and refuses over its own byte cap — fix by compacting
(§3), never by hand-shrinking. An `activeCount` mismatch (COUNT MISMATCH) must be fixed first.

## 5. Bootstrap — create it for a project

1. Create `.claude/lessons/` with a header-only `LESSONS.md`, an `ARCHIVE.md` stub, and
   `_meta.json` (`nextId: 1`, `activeCount: 0`).
2. **Seed if sources exist:** distill durable rules from the project's memory dir
   (`feedback_*`, ⚠️-flagged lines), old postmortems, or a bug register — one entry per *rule*,
   not per incident.
3. Copy [`reference/validate-lessons.mjs`](reference/validate-lessons.mjs) into the project's
   `scripts/` and wire it into the verify chain (`npm run verify` or the project's equivalent
   gate); run it once to confirm it passes against the register just created ("Per-project
   enforcement" below has the exact contract). Without this step the caps above are a
   convention, not a gate.
4. Add a `## Lessons learned routine` pointer to the project's `CLAUDE.md` if it has one.

## Learning clause — mandatory (owner ruling 2026-09-10)

This register is the memory half of the house learning loop: every run **reads** the digest (and the
auto-memory index, §1) before planning and cites the ids it carries; every surprise **records** an entry
the same day, in the same PR — that is this register's per-fix half of the loop, not the cross-run one.
**The cross-run cadence is `/retro`**, not this file: every ten true-telemetry runs it reads the RUN-LOG +
ledger `summary` together, escalates any knob candidate recurring in 3+ entries to the owner, and appends
the `## Retro — <date> · trueTelemetryCount=<N>` marker to RUN-LOG.md (the only writer of that marker). A
lesson whose Guard is a real test may be archived, a lesson without a Guard may not — the Guard is what
makes "never again" true. Quality is the floor: a lesson is never dropped to make byte room; compaction
archives whole entries verbatim (§3) — it never merges or shrinks a live one. Canonical text:
`~/.claude/skills/dev-pipeline/references/LEARNING-CLAUSE.md`.

## Guardrails — do NOT

- Write a lesson (or promote one into CLAUDE.md) that only restates what the repo or config
  already reveals — a type signature, a lint rule, a documented default. **Non-redundancy test
  before any lesson or CLAUDE.md line:** if a future reader would get this by reading the code,
  it is not lesson material — cut it.
- Write incident diaries or changelogs — git history exists. One entry = one generalizable rule.
- Blame people; name causes and missing guards (blameless-postmortem rule).
- Reference client/tenant identifiers or real business/document numbers — placeholders only
  (registers may live in repos that go public).
- Put secrets or env values anywhere in the register.
- Let it grow unbounded — the caps are the point; an unreadably long register is a dead one.
- Duplicate standing instructions: a lesson promoted into CLAUDE.md/README moves there and is
  archived.

## Per-project enforcement (required for the digest / caps to exist)

Two mechanisms, both copied into the project rather than run from the skill directory. Neither
is truly optional: skip the validator and the caps in the artifact section above are prose
nobody checks; skip `--digest` and `LESSONS-DIGEST.md` silently drifts from `LESSONS.md`.

- **Integrity validator** — [`reference/validate-lessons.mjs`](reference/validate-lessons.mjs):
  copy into `scripts/` (§5 Bootstrap step 3), wire into `npm run verify`. Fails on a
  `_meta.json` count mismatch, duplicate/dangling `L-NNN` id, unresolved merge marker, or either
  cap; `--digest` (re)builds `LESSONS-DIGEST.md` (§4); `--verbose` lists every id plus gaps from
  unmerged branches; `--root <dir>` points it at a project other than the one it was copied
  into (default: walk up from the script, else the current working directory).
- **Stop hook** — [`reference/stop-hook.mjs`](reference/stop-hook.mjs): blocks turn-close when
  bug-fix-shaped work (a `fix/*` branch with source changes, or `fix:` commits since the
  register last changed) left `.claude/lessons/` untouched. This one stays genuinely optional —
  the routine in `~/.claude/CLAUDE.md` is the primary, model-driven mechanism for making sure a
  fix records its lesson. (RouteFlow integrates the stop-hook logic directly into its existing
  `.claude/hooks/stop.mjs` as Gate 3.)
