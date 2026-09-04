# Brief — PR-13 · Item 8: flip reconciliation across three files + retirement checklist (docs, light loop)

Branch `docs/imp-08-flip-reconcile-runbook` (after PR-12). Commit type `docs:`. Scale small.
Owner decision 2026-09-03: **keep the flip** — private-minute billing is still broken.

## Facts (surveyed)

Three codified copies disagree: `.github/workflows/ci.yml:1-63` header says the flip ritual was
"retired 2026-08-30" (true for the push trigger; PR CI still needs the public window while
billing is broken); `CLAUDE.md:182-251` prescribes the routine with dated incident narrative
(#367/#369/#371/#374/#376, the `BUILDING` rule, the 2026-08-31 billing UPDATE) — lines 252-267
are unrelated deploy safety and must stay; `.claude/skills/rebuild/SKILL.md` (115 lines, last
touched 2026-07-11) has four stale sites — :16 ("MANDATORY — run ALL 3 steps"), :55 ("$0 GitHub
Actions budget; CI only runs on public repos"), :59/:71 (the `gh repo edit` calls), :108-111 (a
second visibility table) — and states the retired rationale as current fact. No self-hosted
runners exist. Lessons: L-004 (one clean attempt at a blocked flip), L-039 (a private flip after
a green CI is not a `finally`).

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verified by      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| R1  | `docs/runbooks/deploy-visibility-flip.md` (new) is the **single source**: (1) why the window exists today (Actions billing for private minutes broken; a private run dies as a 0-step failure); (2) the exact routine — public → push/CI → merge → wait `BUILDING` (never `INITIALIZING`) → private as a `finally`, read visibility back in a retry loop; (3) the failure modes with their root causes in ≤ 8 lines total (the five `repository not found` deploys = flip during snapshot; `gh repo edit` network failure leaving it public); (4) the **retirement checklist**: billing fixed in Settings → Billing → one private PR run with `steps > 0` → delete the routine from this runbook's three referrers → first private month's minutes vs the 2,000 cap (projection ~2,076 min/mo, unverified) → `ci.yml` header trimmed. | review           |
| R2  | `CLAUDE.md:182-251` collapses to ≤ 15 lines: the routine's five steps in one list, the `BUILDING` rule, the `finally` rule, and a link to the runbook; the owner-authorization sentence (2026-07-31) is kept verbatim (one line). Lines 252-267 untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | review, A1       |
| R3  | `.claude/skills/rebuild/SKILL.md`: :16 no longer says MANDATORY-run-all-3 without the condition; :55 replaced by "while private Actions minutes are unbilled-broken (see the runbook), CI needs the public window"; :59/:71 keep the commands but point at the runbook for the `BUILDING` wait and the `finally`; :108-111 table removed or reduced to a pointer. The skill's behaviour stays: an agent following it still performs the flip correctly today.                                                                                                                                                                                                                                                                                                                                                                         | review, A1       |
| R4  | `ci.yml` header (:1-63): one sentence reconciled — "the push trigger was retired 2026-08-30; PR CI still runs in a brief public window until private-minute billing works (runbook: docs/runbooks/deploy-visibility-flip.md)". No functional change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | review           |
| R5  | Lessons register: archive 3–4 aged/guarded entries to `ARCHIVE.md` **only if** headroom is < 3 KB at the time of this PR (check `_meta.json` bytes); otherwise `updatedAt` only. `docs/IMPROVEMENTS.md` row 8 `docs-only (PR-13; retirement blocked on billing)`. Code-map: none (docs); `_meta.json` `generatedAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | validate-lessons |

## Tests

None (docs). A1 = a Sonnet consistency check: the three referrers contain no contradictory
sentence (grep each for "retired", "MANDATORY", "$0", "only runs on public") and each links the
runbook.

## Files

`docs/runbooks/deploy-visibility-flip.md` (new); `CLAUDE.md`; `.claude/skills/rebuild/SKILL.md`;
`.github/workflows/ci.yml` (header comment only); lessons files; `docs/IMPROVEMENTS.md`.
