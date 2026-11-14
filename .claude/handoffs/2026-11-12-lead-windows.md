# Lead handoff, Windows main session (2026-11-12, final rewrite 13:03Z at weekly 95%)

**Owner:** last typed "Switch to Opus and continue" (model switch is their click). Standing: land green batches without a box; migrations and prod commands need a per-call yes; stop at 99% weekly (reset 2026-11-13 13:00Z). Urgent counter set W-1183..W-1188 first. The lead wound down at 95% with every lane idle: nothing is in flight.

**State (verify before acting):** master `a587d034e76364d4d01fc24f0ab06bcb100caa8a` (window 38, closed 12:59:33Z; board 6824290081), repo PRIVATE, api serves 5a7623d208 (later commits are docs-only), post-deploy PASS 12:04:58Z. Windows 34-38 closed today. Window 38 watchdog pid 27920 exits by 14:28:49Z: no new window before that.

## Landed today
- Window 36 (board 6820288334): #4300 SA-1124 PR-1a offline create, #4301 W-1188 follow-ups, #4303 till scan lost after Escape.
- Window 37 (board 6823118317): #4306 SA-1124 PR-1b invoice review gate, #4302 W-1187 PR-2b cart drag, #4305 W-1188 sale-date chip + repaired window pin, #4304 bookkeeping for windows 35+36.
- Window 38: #4308 bookkeeping for window 37 (B1313 closed, B1314-B1320 new, L-379 new). No bookkeeping follow-up is owed.

## Open PRs
| PR | head | state |
|---|---|---|
| #4263 dependabot, 12 minor/patch bumps | 1ed9dfff5e | no reader; needs a merge-up check, one reader, a window |
| #4307 WEB_ORIGINS for sign-in and payment returns (DRAFT, feat/wp2a0-web-origins) | 76490c7ef7 | opened 11:49Z by another session, not by this lead; auth + billing = Tier 1; find its owner first |
Every red CI outside a window is the billing block (0 steps, repo PRIVATE).

## Next work
- Counter set left: PR-1i parked (additive `position` column, needs the DB sitting); office Search hand-over after a scan; captures/e2e 08+56 never run; W-965 needs a ruling; register rows B1310, B1314-B1319 (till lowercase start, office Escape closes Create Order, sub-10 ms keyboard move, sale-date orderDate test, copy pin, Alt+D under a dialog). Mobile drag: not built (owner 10-24).
- Factory PR-1a2 25b47d8907 (wt/factory-sa1124): needs the owner box SA-1134-O1 first (cancelled draft reopens as draft (Recommended) or live); never asked. Merge it up to master before review. B1311, B1312 are its neighbours.
- Lead-skill promotions due: "Two failed rounds on one criterion means a new spec, not a third patch" (3x) and "Verify before instructing" (76x, already §2); SKILL.md is 16374 B of 16384, archive a stale rule first. L-379's guard (order template carries the board ids of the verdict and its evidence) is NOT BUILT.
- SA confirmations owed (no SA lane): lead rulings on #4293, #4274, sale-date noun prop, #4301 item 1 withdrawal, #4302 (no key timing; four stated limits), #4303.
- Window scripts: copy `local-assets/lead-2026-11-11/train37-head-check.sh`, `train37-window.sh`, `open-window-37.sh` (sed master sha + MEMBERS; a single docs-only member needs no head check, see train38). Gaps (B1309): a runner-cancelled step read as a real red; a superseded commit's pending deploy printed as DEPLOY NOT ALL SUCCESS (check the last code commit's statuses and /health by hand); ls-remote one second after the private flip returns 403.

## Waiting on the owner
1. (DONE 2026-11-12 by owner yes: B1305 private entry pushed to the private specs repo, commit 031695370.)
2. SA-1134-O1 box (above).

## Lead errors logged today (lead log, guards inside)
#4298 security wording in a bug row; #4301 item 1 key-order rule; #4302 fix ordered from an interim verdict; #4302 hold issued before the trace returned; #4308 a path:line relayed unread into four places; one message stamped with an estimated time (use `date -u`).

## Lanes (SendMessage ids), all idle until the reset
counter `local_83b49529-16ea-46a0-82a8-0f93a5d30ffa`, win-heavy `local_a4cd0fc9-9109-4908-b38c-d8772fa6142e`, win-books `local_39154967-049d-4de6-b23e-db3163c49c80`, Mac mini heavy lane (by name; no trees left). PC heavy slot free. PC worktrees wt/train35-head, train36-head, train36b-head, train37-head are spent (janitor report-only first; never remove --force).

Records: ledger `local-assets/growth-review-2026-11-04/ledger.md`; lead files `local-assets/lead-2026-11-11/` (train36-38, board-window36-38.md, next-lead-prompt.md); board #3686.
