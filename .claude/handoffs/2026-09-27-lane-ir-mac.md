# Lane IR (Mac mini) handoff, 2026-09-27T00:29Z

Window "B681 ledger correction review" = RouteFlow Lane IR inline returns web. Lead: RouteFlow Mac Lead coordination.
Worktree: `.claude/worktrees/rf-mac-2107` (npm ci'd). Verify SHAs with `gh`/`git ls-remote` before acting.

## Pushed PRs (awaiting others)
- #2107 B680 @0637470410 (SA re-read, Opus, F2 DB)
- #2234 (#2201 commission sync + SA-392/393/394) @15c30bad6 (F2 re-run + Opus)
- #2245 (#2181 CreditNoteItem every line + SA-401a qty cap) @2d586fdd1 (F2 DB, SA, Opus)
- #2318 (#2312 store config + iOS babel NODE_PATH fix) @2faf240b7 (lead PASS-with-nits → re-review)
- #2319 (#2313 store listing docs) @6fb19dbc2
- #2323 (SA-065 resync extraction, W7 first) @3ac564438

## Held locally (do not push without a slot)
- #2249 slice: `ir/2249-ratchet-slice` @55795b03 (ff on origin fix/2197 225e158d). Push after #2250 lands. Row NOT changed (would raise on old base). Lead-OK'd rule: at update-branch the row = LOWER of master's row or merged measured size; never raised. Lead delta-reviews 55795b03 after push.
- #2242 `bug/2242-nsf-line-survives-sibling-rebuild-v2` @afaa1af4 (80b41434 fix + afaa1af4 test move)
- #2268 `bug/2268-nsf-invoice-resyncs-after-edit-v2` @bb385bb6 (fix only; extraction = #2323)
- #2243 `bug/2243-nsf-line-never-taxed-v2` @7dc1e124
- #2200 `bug/2200-unify-tx-conflict-predicates` @12ccf32b (rebuild after #2234: drop credit-notes hunk)
All NSF branches stack on #2250 (8bdee9f5); rebuild by cherry-pick onto master after #2250 lands; conflicts were import-only in simulation.

## Train A (owner: 3 merge trains), #938 5851431552
origin `train/A` @09957b88, tree e98a41e8 (14 PRs; dropped #2240 #2185 #1358 #2241). Verify green; F2 owns stack/validate/drift/DB on it. Coordinator squashes in order; master tree must equal e98a41e8. Local `train/A-v1-with-2241` = failed first build.

## Ratchet (invoices.service.ts) W7 sim, #938 5851252136
Order A over cap from #2249; standing rule: each over-cap PR carries its own behaviour-neutral slice (I own it for this stack).

## Traps hit
- Campaign freshness blocks pushes: regen `apps/<ws> npx jest --maxWorkers=2` after scoped runs or merges.
- `prisma generate` on the #2250 stack leaves the client wrong for master branches → regen per branch.
- Spec files are excluded from api tsconfig; typecheck specs with a temp tsconfig.
- Local `tmp/*` sim branches exist (safe to delete later).
