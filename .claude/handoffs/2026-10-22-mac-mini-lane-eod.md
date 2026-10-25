# Mac mini lane: end of 2026-10-22 (idle until the 10-26 08:00Z weekly reset; lead at 95%)

**Lead:** the session "Routeflow Lead" (Windows box, since 10-22). The PC lead is retired; never report there.

**Landed today:**
- #3535 (product open-orders card): merged.
- #3607 (Ops Monitor UI fixes U1, U3-U8, U7 stub): merged 20:2xZ (master 8be238e99, then 327e9abe1).
- Ops Monitor eval report: routeflow-specs 49cafa53, `specs/ops-monitor/ux-eval-2026-10-22/report.md`.

**Open:**
- #3602 (row 742, units card structure-only on v2 variants and recipes). Opus PASS. The lead's window runner moved it to 4dc800efa; its CI runs in a lead window. **Do not push to it.**

**After the reset, in order (the lead confirms first):**
1. Row 748: the #3535 nits (a)-(e). Card: `.claude/handoffs/2026-10-22-row-748-open-orders-nits.md`.
2. Row 749: the server guard. Ruling A: refuse governed (variant/recipe) unit PRICE writes with a coded 409, ONLY under `flag.units_prices_v2`; structure writes stay allowed.
   - Needs EntitlementAuthority in ProductUnitsService, so a DI carry check plus a compose boot gate.
   - The red spec (14 red / 3 green) and the UNIT_PRICE_GOVERNED code patch are parked in `local-assets/r749/`.

**Machine state:**
- Worktree `~/code/rf-wt-742` (has node_modules) is on `feat/ops-monitor-ui-fixes`, which is merged. It can be reset onto origin/master for the next card.
- Worktree `~/code/rf-wt-r3img` holds the #3535 tree (merged), so it can be cleaned up.
- No stacks or servers are running.
- Own-port compose template: `rf-wt-r3img/local-assets/r3535/` (api 3410, web 3411, pg 5452; redis 6419, because R7b holds 6399).

**Known red:** the `ops:test` brief.test "Windows paths compare case-insensitively" fails on macOS, master included. The lead filed it as a row for the monitor owner.
