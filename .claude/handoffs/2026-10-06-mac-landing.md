# Mac mini landing coordinator: handoff, 2026-10-06 (weekly usage at 96%)

**Rules:** follow the CLAUDE.md deploy flow. Scripts live in `local-assets/landing/`:
- `premerge.sh <pin>`: combined-tree check-types.
- `mrg.sh <N> <pin>`: checks pin, base, Verify and tree, then squash-merges.
- `dep.sh <sha>`: waits for api and web SUCCESS.

Before landing, read the run log's "Merge X into Y" (lesson L-266). A close/reopen can replay a cached merge commit.

**In-window rule (lead):** a PR's CI base may trail master only by merges from the same window. Those merges must be:
- mergeable;
- green on combined-tree check-types plus the web tests of any overlapping file;
- additive in their overlap only.

## Master
`db12f236` (bookkeeping #3241), with code at `fff02f01` (#3223). The repo is PRIVATE.

## Next window (W12): land in this order
1. **#3226** @`8770d92edd731cfcc6218a39eeb5a7ff7dd0c358`: CLEARED (lead Opus PASS + SA-699c PASS).
   - The owner's census returned 0/0. Put "census 0/0 at 13:2xZ" in the merge note.
   - Needs fresh-ref CI. The billing DB lane was green at that sha (27 suites / 260 tests).
   - Do NOT move the sha.
2. **#3232** @`9af12d474fa1945ffdb0daa02908496d2b29bcc9`: lead PASS (the conflict resolution is import-only).
   - Needs the Mac D10 + SA-696 pixels first: carrier bulk cancel/delete reasons, and Edit Items refused on carrier orders.
3. **The stale five** (#3116 306052f5, #3119 126e292d, #3117 f8bd1a68, #3106 48828a05, #3102 8c0bc4c3).
   - Land a PR ONLY where #2554 shows a prior PASS and the delta is merge-only.
   - #3116 also has a ratchet move, which the lead OK'd.
4. **#3242** (B1150): pixels PASS at 3 widths, but waiting for the MacBook's 640–700px tile fold. Re-shoot that range after.

## Waiting on others
- #3198: PC re-merge, then Mac pixels with the review badge and SHIP label, fleet off and on.
- B1132 (D14): a PC builder; Mac pixels when pushed.

## Next bookkeeping
- Close: B1121 (#3223 fff02f01) and the W6 fixes B1031, B1051, B1058, B1082, B1083.
- Mint: B1152 to B1159.
  - B1152: comp sums.
  - B1153: externalPayment stays true.
  - B1154: stale pointer gets no DUE notice.
  - B1156: READ_ONLY with a null reason.
  - B1157: "stored is live" silence. Must be fixed before Stripe goes live.
  - B1158: never cancel a `processing` superseded incomplete sub. Must be fixed before Stripe goes live; the owner keeps bank debits.
  - B1159 (LOW): 360px Payment History clip.
- Code-map bullets for #3240, #3235, #3223 and #3226.
- Lesson L-267: a retry-with-the-same-key code excludes states an office action ended (#3211).
- The full queue is in `local-assets/landing/queue.md`.
