# Handoff — landing coordinator (Mac), 2026-09-29 ~04:00Z

State read by command at 03:59:27Z.

## Window state
- Repo najathakram/routeflow: **PRIVATE** (read back). No visibility watchdog running. Nothing in flight (no merges, update-branches, CI waits).
- Last window closed 22:46:46Z Sep 28. The owner's "Renew until 23:00Z" (#2554 5873504373) is EXPIRED. **No new public window until the OWNER renews, posted verbatim on #2554** (lead cannot renew for them).
- Owner PAUSE (~02:31Z Sep 29): no pushes/verifies/Docker/flips/merges until the Mac Lead/lead resumes. Seats are being rotated into fresh sessions.
- Do NOT touch the PC's shared .git/config (core.bare=true) — owner repairs it.
- master = faf4675971b549fc11feacedde67544045d089f6 (after #2726, docs).

## Queue (heads from `gh api` at 03:59Z; all base=master, not draft)
| PR | head | state | notes |
|---|---|---|---|
| #2729 | 739419967d2fa080d3f53fc021eff557fb9c5042 | clean | Fully gated earlier at short 71f87b71 (verdict on #2554 — re-read the full sha there). Head is my last update-branch onto 62afbed3; now 4 commits BEHIND master. Needs `ubr.sh` re-update, predict tree, send head+tree to Mac Lead for the SA-510l carry check, then CI. |
| #2690 | e041ae620e4880db7644239a835fa043058f4bdf | DIRTY | Rebuild onto master after #2686 (landed); its lane owns the rebuild. |
| #2725 | c9568dfaf2daed1bc0d6ad63a4f28c009a0c7a30 | unstable | Gates pending. |
| #2241 | 63018bf87a3155ee38951c5be4651b77adc09382 | unstable | DI fold (EntitlementAuthority in new specs) pending; earlier real red. |
| #2185 | 5163c458df16c3689094618d1851118f4c7a9ec3 | DIRTY | Lands after #2241. |
| #2679 | 46352e40f40821c61e7f61da245c30a1042d5c3e | clean | Waits on its fold/salvage; verdict not confirmed. |

Any sha movement re-pins the gate. Verdicts live on #2554 at exact shas — verify there before merging.

## In-flight carries
None open. Carry rule: SA-510l — F2 evidence carries only if the exercised code is byte-identical (`git merge-tree --write-tree <gated> <master>` == `<newHead>^{tree}`); otherwise fresh F2.

## Owner-only steps (not the coordinator's)
- v13 catalog prod publish (#2707 deployed, SUCCESS 21:58Z).
- EAS build/submit for #2686's native side.
- 100000 prod migration for #2486.
- HANDOFF_TOKEN_SECRET, Plaid application, `b294 --apply`.

## Procedure (next coordinator)
1. Check `date -u`, visibility, `pgrep -fl "^node scripts/visibility-watchdog"` first (an app restart kills the watchdog).
2. Open only after a fresh owner renewal on #2554: start watchdog detached with `--minutes` capped so deadline ≤ expiry, then flip public, read back.
3. Before each merge: base=master, not draft, gated sha == head, CI log "Merge X into Y" base == current master, real green (a 2-5s zero-step red is billing-blocked, not a result).
4. REST merge: `gh api -X PUT repos/najathakram/routeflow/pulls/N/merge -f merge_method=squash -f sha=<head> -f commit_title="$T (#N)" -f commit_message="Bookkeeping-Follow-Up: pending"` (docs: "Docs-only rolling bookkeeping (Option B)."). Check the ref after; wait deploy SUCCESS for api/web/mobile between code merges; then `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app node scripts/post-deploy-check.mjs`. Docs PRs last.
5. Flip private as a finally; read back. Never extend a watchdog.
6. Prefer REST `gh api` (GraphQL rate limit shared). Count landings by command, never by hand.

## Helper scripts (scratchpad, session-local; recreate if gone)
`ubr.sh <PR> <currentHead>` (REST update-branch + tree identity) and `wr.sh <PR> <head>` (REST CI waiter + tested base). Under /private/tmp/claude-501/-Users-maznahamanullah-code-routeflow/4c3f50de-5b04-4bd5-9f85-1681500e31a1/scratchpad/.

## Memory pointers
window-renewal-is-owner-only, count-landings-by-command, app-restart-kills-visibility-watchdog, check-priority-pr-before-merging-ahead (barrel files collide).
