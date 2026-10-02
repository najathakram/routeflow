# Handoff — 2026-09-22 · b707-edit-items-pack

- Task: Fix B707 — mobile order edit-items seeds a line's pack from the LIVE product instead of the line's own stored value.
- State: DONE — PR #1245 MERGED (mergedAt 2026-09-22T18:29:18Z, mergeCommit f10bf3b55dc3952e7309a2b0a46ffeb73f7720df, now part of master). PAUSED 2026-09-22 per fleet lead (owner updating Claude, sessions may be killed) — no work in progress, nothing uncommitted, nothing to push.
- Branch/tree: fix/b707-mobile-edit-items-line-pack @ fb434fbd35eafc1be43cf22f4be876313af0081d · uncommitted: none · worktrees: .claude/worktrees/rf-lane-b707 (this one)
- Run: none — direct builder task, no dev/bug-pipeline run
- Decided:
  - Extracted `hydrateFromOrder` out of edit-items.tsx into lib/edit-items-draft.ts (exported, pure) so jest can reach it — mirrors #1171's `at-door-line-units.ts` extraction.
  - Used `lineUnitsPerBox(li)` (own snapshot first, live product fallback) instead of inventing a new helper.
  - unitLabel threads through DraftItem → DiffCatalogLine → buildOrderItemDiff's UPDATE branch, which now sends `{id, qty:<unit count>, unitLabel}` for a unit-aware line, no boxes/pieces.
  - Code-map/lessons NOT touched in this PR — Option B, `Bookkeeping-Follow-Up: pending` trailer on HEAD commit instead.
- Next:
  - PR #1245: https://github.com/najathakram/routeflow/pull/1245 — needs Tier 1 (2 independent PASSes) at fb434fbd, fleet lead assigns.
  - After merge: docs-only follow-up PR updates .claude/code-map/mobile/screens-by-role.md (edit-items.tsx / edit-items-draft.ts entries) + lessons register, citing merged sha.
- Open for owner: none
- Do not: touch this worktree (nothing to tidy, no disk pressure per coordinator); don't re-derive the code-map edit here — it belongs in the Option B follow-up.
- Areas touched: mobile
