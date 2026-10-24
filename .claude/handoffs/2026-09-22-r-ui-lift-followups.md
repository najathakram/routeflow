# Handoff — 2026-09-22 · r-ui-lift-followups

- Task: R-ui tonight — lift-dialog follow-ups, sweep-red push, B700 (pack-at-sale snapshot-first), B715 (scan-price tap affordance).
- State: done, closing out for the night. All 4 PRs pushed/open. Inline-returns web capture is next, morning, cold (see below).
- Branch/tree: main checkout detached @ b754c33f · worktrees mine: rf-lane-R-ui-sweep-red (715cd1f7, PR #1230 open), rf-lane-R-ui-b700 (ef06d4e1, PR #1237 — merged, 2 PASSes, safe to retire), rf-lane-R-ui-b715 (17248086, PR #1240 open, tier-2 gate). Do not touch rf-lane-R-service-3 (not mine).
- Run: none — no dev-pipeline/bug-pipeline this session, direct manual fixes throughout.
- Decided:
  - B700: `packAtSale = it.unitsPerBox ?? packMap.get(it.productId) ?? null`, snapshot wins. Two PASSes (Lead + S-scan).
  - B715: pencil + "Tap to change" gated on `onTapPrice`, no behaviour change, Playwright-proven at 390px.
  - Red-first fleet-wide now: `git diff > patch` → `checkout --` file → run (red) → `git apply` → diff patch-vs-current (empty) → rerun. No `git stash` — shared stack, real collision risk.
- Next (MORNING — explicit Lead instruction, also in Lead's handoff):
  - Add 3rd paragraph to `LOCAL-LANE.md`'s dev-preview trap section: a throwaway proof route leaves a `.next/types/` stub after the source is deleted — `rm -rf .next` before push, re-run `tsc --noEmit` AFTER manual-server capture not before (bit me on B715's 1st push attempt). Fold into inline-returns PR or standalone — Lead's call.
  - Inline-returns web capture (PR-1): brief at `local-assets/handoff/2026-09-22/SPEC-inline-returns-capture-web-PR1.md` (SA-071a/b). Read cold.
  - #1230, #1240 still open — not mine to land, check status first.
- Open for owner: none.
- Do not: re-touch rf-lane-R-ui-sweep-red/b715 without checking PR state first. No `git stash` in these shared worktrees.
- Areas touched: web (LiftRuleDialog.tsx, LineItemRow.tsx + tests, LOCAL-LANE.md), api (pack-at-sale.ts + spec).

PAUSED (owner Claude update, 2026-09-23T01:36:37Z): nothing in progress, all worktrees clean/committed/pushed, no push/merge pending — see state above.
