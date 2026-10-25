# Mac mini lane handoff — 2026-10-20 (usage freeze at 91%)

**State:** nothing new starts (owner rule at ≥ 90% weekly usage). All of this lane's work is pushed.

## My PRs (draft)
- #3538 row 630 (derived Piece uses the line's own price/size), head 804fb947f. Opus PASS-WITH-NITS. Needs an SA delta-read.
- #3545 product page d9f24fbef · #3546 change prices 06f07ea38 · #3547 customer view d008ccf56 · #3548 list/family 550e60509.
  - Integration `integ/r3-proof` @ 1f059e012 (rf-wt-r3img): full units-v2 34/34 green, Jest 1207 green.
  - apple-ux and apple-design PASS (Opus re-check, shots in ~/code/local-assets-proofs-r1/r3-recheck-afeaf80b6/).
- Kept by ruling: Change prices stays live while inline editing (K11-15/18); the disabled Pricing unit select stays (row 614).
- `page.tsx` is 2939 of 2942 under the ratchet. Extract before adding anything.

## Lanes I own (sessions)
- Stock count row 657: #3540 and #3541. #3541 HOLDs until sitting #2. SA-828a parts ruling relayed (fold if small, else card).
- Invoice units row 663: #3542 and #3543. #3543 HOLDs until its migration is on prod. SA-827a precedence differs from the build; SA-827b rule 8 confirmed. Both relayed.
- Mixed boxes 664/665: PR-0 part 1 is local only (7b1f55226). SA-825a relayed. PR-a/PR-b wait for row 655 PR-2, which has not started.

## Host
- Host stack: api :3000 and web :3001 both from rf-wt-r3img (my PIDs). The compose api/web containers are stopped, not removed.
- Disk is about 13 GB free (below the 20 GB rule; the owner has the cleanup list). The Colima VM has 3 GB free. No new installs.
- The shared core.hooksPath must be the shim (an npm ci rewrote it once on 10-20).

## Next after the reset (in order)
K14 on the R3 image, then SA-817 order resume proof, #3106 cart check, row 631 returns series, row 643 counter sales (3 batches), row 646, rows 634/635/637.

Lesson candidate: the K11-23 390 e2e false-greened on a loose label probe, and a `:text-matches("…\d…")` selector never matches (it unescapes `\d`). Use `getByText(/regex/)`.
