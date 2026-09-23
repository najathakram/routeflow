# SA seat ledger — one row per session, counted from the registers (never estimated)

| session (UTC) | rulings | amended after execution | withdrawn | HOLD→PASS round-trips | builder catches | SA errors A/B/C/D | reads merged before the read | notes |
|---|---|---|---|---|---|---|---|---|
| 2026-09-22 06:23Z → 2026-09-23 ~10:00Z | 30 (SA-045…SA-074, + a/b sub-rulings) | 6 (SA-047, 052, 059, 068 ×2, 071a ×2) | 1 (SA-045 PASS → HOLD) | 2 (#1207 via #1219; #1239 test-only) | 6 (SA-052 ×2, SA-068 map, SA-068 case c, SA-071a replayed, SA-071a invoice) | 3 A / 8 B / 0 / 0 (E9–E20, E18 counted as B) | 3 (#1207, #1232, #1234 — all verified post-merge) | first session of the seat; the recurring shapes: a state last observed reported as current (A); a claim never executed against the thing it describes (B). Promoted to 7.1: checks 2, 3, 4, 5, 6. |

| 2026-09-23 ~10:00Z → ~21:00Z (retro 1, same session) | 27 lines counted by grep of SA-075…SA-080 + every sub-ruling/amendment/confirmation line written after the first row (over-inclusive by a few earlier sub-rulings; method stated so the next row can match it) | 7 (SA-068 ×2 wire fields; SA-070(a) rename; SA-071a ×2; SA-077b normalization withdrawn; SA-072 "hold may lift" withdrawn) | 1 (SA-072's hold-lift line) | 4 (#1239 test-only; guard test-only pending; #1246 3 fixes + 2 gate rulings pending; B717 2 fixes → PASS) | 9 (Lane IR ×2, Mac Lead ×1, the hunt ×2, the B717 lane ×3, Lane B ×1) | 1 A / 3 B (E21–E24) | 0 (#1236, #1237, #1243, #1245, #1253 all landed after the PASS; post-merge blobs identical) | Shape B (a path not traced beyond the diff) now dominates: two PASSes shipped defects (E22 overcharge, E23 headline not closed). Promoted: check 8 producer/consumer (new), check 2 wire (E19/E20). Nothing retired (three-row rule). Reads-before-merge went 3 → 0. |

| 2026-09-24 (retro 2, same session; SA-081…SA-090 + sub-rulings, ≈19 lines) | 19 | 2 (SA-082 guard 2 unmeetable → SA-082b; SA-082 mechanism → SA-082a) | 0 | 3 (fleet lead ×2, Mac Lead ×1) | — | 0 A / 2 B (E27 near-miss, E28) | 0 | Both errors: a cause or an absence named without reading the deciding artefact. Promoted: read the trigger before naming why a run did not happen; absence only by unfiltered grep of the control's own name. Nothing retired. |

## Reading the row
- **amended after execution** — rulings a builder or lead proved wrong by running or reading; the number the seat most wants at zero.
- **builder catches** — a catch is credited to the lane; the seat's job is to make the next one impossible by a check, not by asking the lane to be careful.
- **reads merged before the read** — every one is a coordinator gate, not an SA failure, but the seat records them because a post-merge PASS is worth less than a pre-merge one.

## Retro cadence
Every ten rulings, or at session close: append the row, compare with the previous, then promote/retire per SKILL.md §7.3. Retro 1 done at SA-080 (2026-09-23 ~21:00Z). Retro 2 done at SA-090 (2026-09-24). The next retro is due at SA-100 or session close, whichever is first.
