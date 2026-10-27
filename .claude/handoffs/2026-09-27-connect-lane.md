# Handoff — connect/vendor-bills lane · 2026-09-27 14:33Z · SAFE POINT (owner order)

Lane name: "Extract and fix vendor-bills poTotal drift" (Mac). Nothing uncommitted; nothing pushed ungated.

LANDED: #2451 (#2441 Connect) merged 13:21Z. #2250 (#2169) + #2247 (#2191) in train A (#2327).

OPEN
- #2185 (B858/B859 import, took over) @b6205da6 — waits #938 PASSes + F2 rerun.
- #2031 web invoice legacy tax (B294 web half) — LOCAL ONLY @5b18f16b, tree
  .claude/worktrees/fix-2031-vb-legacy-tax (no node_modules). SA-368/368a done.
  Owed: Playwright 1440/768/390 (F2, blocked + decided states), verify slot, push, PR, tier-1 PASSes.
- #2190 invoice importer money (SA-382) — not started; builds after #2185 merges.
- #2452 Connect platform-acct census — NOT claimed (lane:billing held by #2440; relabel asked).
  Must use scripts/lib/report-db-url.mjs (B768), read-only, owner-run.
- #2455 deauthorize residual — filed; needs adding to Project #3 (my gh token lacks project scope).

UNFILED: bug ids from #2031 (web recurring n/a; mobile unverified-rate gap; blended-rate-on-exempt
lines) — waiting on who files.

TREE: focused-knuth-179e2b has node_modules (the one allowed install); on fix/2441 @4946e9c3.
Close-out owed: bug-pipeline closeout for #2031 and #2441 (ledger/RUN-LOG/lesson via Option B).
