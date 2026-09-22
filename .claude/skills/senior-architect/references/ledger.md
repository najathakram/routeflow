# SA seat ledger — one row per session, counted from the registers (never estimated)

| session (UTC) | rulings | amended after execution | withdrawn | HOLD→PASS round-trips | builder catches | SA errors A/B/C/D | reads merged before the read | notes |
|---|---|---|---|---|---|---|---|---|
| 2026-09-22 06:23Z → 2026-09-23 ~10:00Z | 30 (SA-045…SA-074, + a/b sub-rulings) | 6 (SA-047, 052, 059, 068 ×2, 071a ×2) | 1 (SA-045 PASS → HOLD) | 2 (#1207 via #1219; #1239 test-only) | 6 (SA-052 ×2, SA-068 map, SA-068 case c, SA-071a replayed, SA-071a invoice) | 3 A / 8 B / 0 / 0 (E9–E20, E18 counted as B) | 3 (#1207, #1232, #1234 — all verified post-merge) | first session of the seat; the recurring shapes: a state last observed reported as current (A); a claim never executed against the thing it describes (B). Promoted to 7.1: checks 2, 3, 4, 5, 6. |

## Reading the row
- **amended after execution** — rulings a builder or lead proved wrong by running or reading; the number the seat most wants at zero.
- **builder catches** — a catch is credited to the lane; the seat's job is to make the next one impossible by a check, not by asking the lane to be careful.
- **reads merged before the read** — every one is a coordinator gate, not an SA failure, but the seat records them because a post-merge PASS is worth less than a pre-merge one.

## Retro cadence
Every ten rulings, or at session close: append the row, compare with the previous, then promote/retire per SKILL.md §7.3. The next retro is due at SA-084 or session close, whichever is first.
