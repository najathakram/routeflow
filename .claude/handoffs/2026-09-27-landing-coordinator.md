# Landing coordinator: handoff 2026-09-27 ~14:35Z (safe point)

- **State:** repo PRIVATE (I read it back at 14:19:33Z), master `886fe727`, post-deploy-check passed. No window open. Watchdog 67992 expires 14:40Z and is harmless. Nothing mid-merge.
- **Full landed/rolled list:** #938 5856752856.
- **Queue:**
  - #2433 @5b4b0a04: an Opus REQUIRED fold is open.
  - #2419 @a66c4732: confirm its gate.
  - Docs #2244 / #2408 / #2412: need the tier-2 PASS posted on #938.
  - #2458: waiting on the Opus delta @29ca0cd2.
  - #2474: needs Opus + F2 + the owner's prod migration.
  - #2475 (new).
  - #2460: after #2458.
  - #2151: after #2135's salvage rebuild.
  - #2385: held, blocked.
  - #2423 / #2425: migration-ordered; do not land.
- **Per-PR routine:**
  1. Check the gates on #938 at the head.
  2. Run `scratchpad/ub.sh <PR> <gatedHead>` (update-branch + tree identity).
  3. Post the evidence on #938.
  4. The lead or Mac Lead confirms the tree.
  5. Close/reopen for CI.
  6. Before merging, the run log's `Merge X into <base>` base must equal `ls-remote master`.
  7. `gh pr merge --squash --match-head-commit <head>` with the body `Bookkeeping-Follow-Up: pending`.
  8. `ls-remote`, then Railway SUCCESS on all services before the next merge.
- **Windows:** a 180-min watchdog before going public; never extend; flip private at the end and read it back (owner: "stay public longer" until Oct 3).
- **Prod redeploys / `railway run`:** the owner's per-call yes in the owner's window. A relay can't carry it.
- **Gotchas:** see memory for the stale merge ref (only a push refreshes it) and next/font Google fetch failures. `bugs-self-test-script.spec` flakes; a rerun on the same base is OK. #1315's spec check-types gate reds any new spec type error.
