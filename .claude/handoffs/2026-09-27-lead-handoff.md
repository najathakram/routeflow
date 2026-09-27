# Lead handoff — 2026-09-27 13:15Z · all 3 machines + Cloud

> **OWNER, ON RETURN: run these first, one per box (added 15:20Z; the owner left before the branch command was sent).**
> 1. Mac mini Terminal, the #2423 prod migration (skip it if you already ran it before leaving; it's idempotent, and only 20260927043000 should be pending):
>    `cd ~/code/rf-prod-migrate && BACKUP_DIR="$PWD/backups" railway run --service postgres node ../rf-prod-migrate-2423/apps/api/scripts/backup-production.mjs pre-2423 && railway run --service postgres node ../rf-prod-migrate-2423/apps/api/scripts/prod-migrate.mjs; echo "exit=$?"`
> 2. PC PowerShell, delete the 2 fully-landed branches (re-checked against GitHub at 15:15Z; the other 97 either belong to open PRs or hold unmerged work):
>    `gh api -X DELETE "repos/najathakram/routeflow/git/refs/heads/wip%2Fadmin-modal-a11y"; gh api -X DELETE "repos/najathakram/routeflow/git/refs/heads/wip%2Fplan-gated-nav"`
> 3. (after #2425's migration) **#2486 Sign in with Apple, part A** (SA-477): backup pre-2309, then prod-migrate (exactly 20260927100000), then schema-drift 0, then set the FOUR APPLE_* variables on the Railway @routeflow/api service. The lead posts the exact command when #2486 is gated.
> 4. GitHub repo secret **E2E_DRIVER_PASSWORD** (for #2029 driver-mode's CI proof; the wiring is optional until it's added).
> STATUS 15:45Z: #2423's migration was already in prod (the owner's run showed NO DRIFT). The #2425 migration command was given to the owner at about 15:35Z; result pending.
> 5. **OWNER DECISION (SA-481/SA-471):** #2500 is being built as option B hardened: the client-requested live fresh-start wipe path is KEPT but made strictly safer (one resolved URL, explicit --local / --live-tenant-override paths, --backup-taken + type-back, the two live tenants excluded). Question for you: retire the live fresh-start path entirely instead (option A)?
> Owner answers recorded at 15:15Z: Stripe prod key = standard sk_ (no action); #2093 = audit log + warning; the SA decides while the owner is away (SA-471); PowerShell is allowed in .claude/settings.local.json on the PC.


Written by "Routeflow Lead" (PC) after the PC desktop app crashed ~08:15Z (every PC session stopped;
the Mac/MacBook/Cloud sessions kept working and landed PRs). Owner order 13:10Z: bring every session to a
safe point and record everything. **Re-verify every sha with `gh`/`git ls-remote` before acting.**

## 0. Facts at 13:14Z
- master `3b08ae0644e825ab42294c878245a83e6e4149d7`. Repo **PUBLIC** — a landing window opened 11:40Z,
  Mac watchdog pid 67992, **deadline 14:40Z**. If no coordinator is alive by then, the owner flips it:
  `gh repo edit najathakram/routeflow --visibility private --accept-visibility-change-consequences`
  and reads it back: `gh repo view najathakram/routeflow --json visibility`.
- Open PRs: 57. Board of record: issue **#938** (verdicts, shas). Work board: GitHub Project #3.
- Plan page (3 releases): https://claude.ai/artifact/52CggRerUxodGQcapYVALk · Credit/returns report:
  https://claude.ai/artifact/6j3dcx9FxRZkWYg3nVXX3f

## 1. Goals & release map (owner rulings 2026-09-27)
- **Release 1: DONE** (29/29). Owner may switch on `units_v1` any time (agents never flip prod flags).
- **R1.1a — today Sep 27** (30 open / 12 closed): Stripe money side-track epic **#2435** + credit notes +
  security + everything that was due Sep 28–29.
- **R1.1b — Sep 29** (48 open / 10 closed): all items previously due ≤ Oct 2.
- **R1.1c — Oct 1** (32 open / 0 closed): everything else. Dates are the LATEST, not targets.
- **Native 2.0 — kit + buyer (Oct 8)** (23 open / 2 closed), parallel track, PC lanes N-kit + N-buyer,
  brief `local-assets/handoff/2026-09-27/native-lanes-brief.md`.
- CI budget ruling: "stay public longer" (batch many PRs per window; trains before singles).

## 2. Landed today after 08:15Z (Mac coordinator, window 11:40Z)
#1315, #2453, #2427, #2446 (Stripe P0 period), #2432, #2420, #2444, #2428, #2461, #2445 (welcome email),
#2459, #2462. Earlier today: trains A–D, #2378, #2380, #2399, #2393, #2414, #2411, #2245, #2281, #2384,
#2426, #2376, #2289, #2280, #2235, #2140, #2430.

## 3. Merge-ready queue (tier-1 content complete on #938 — needs only update-to-master + CI base = master)
| PR | sha (gated) | closes | verdicts on #938 | notes |
|---|---|---|---|---|
| #2451 | 4946e9c3 | #2441 Connect ≠ platform acct | SA-460a + lead Opus + F2 | 7 behind master, clean merge. **Owner check:** prod STRIPE_SECRET_KEY must be able to `GET /v1/account` (sk_ yes; rk_ may not) |
| #2465 | dd24aaef | #2440 subscription upkeep | SA-461b + lead Opus + F2 8/8 | follow-ups §6 |
| #2467 | 738f0353 | #1730/B735 parked reversal | SA-469 + lead Opus + F2 | supersedes #2104 |
| #2464 | eb8eb3a9 | #2463, #2290 import VOID | SA-467/468 + lead Opus + F2 | CI green at sha |
| #2433 | 5b4b0a04 | B562 PR-3 cost replay | SA-455 + lead Opus + F2 | cites #2449 |
| #2419 | a66c4732 | #2206 prod guard (security) | SA-445 + lead Opus | check F2/CI |
| #2448 | 1c34dcc5 | #2437 live cutover runbook | SA-457a + lead Opus + F prover (option c, #938 c-5856252229) | tier-1 complete; items 4-5 = owner's own cutover run. Docs follow-up REQUIRED before owner runs it (§6) |
| #2469 | 3db8d2b6 | #2466 payment lock order | SA-470d + lead Opus + F2 re-run | CI owed: every check is the billing-block pattern → re-run in window. Follow-ups §6 |
| docs | #2244 81c1242b, #2408 fbd8acd0, #2412 fcbfe982 | — | scope-checked docs-only | tier-2 PASS still to post; land serially, drop on `_meta.json` conflict |

**Not ready:** #2458 (lead Opus: downgrade cron still rewrites the override fee — SA must rule fix-in-PR vs
"Refs #2223"; DIRTY, import-only conflict) · #2425 (needs owner migration order, below) · #2423 (DIRTY; owner
migration first) · #2385 (BLOCKED: its merge reverts 4 master app files — restore apps/ from master) ·
#1351 (needs review) · #2431/#2454 drafts · #2442 v2 branch 6c4717ce (SA-462a + F2 PASS; stacked on #2465 — PR after #2465 lands) ·
#2468 branch ca925dce (SA-468b + F2; stacked on #2464) · #2460 (SA-464a; stacked on #2458).

## 4. OWNER actions (verbatim, each complete)
1. **#2423 prod migration** (Mac mini Terminal) — blocks credit-note PRs #2423/#2402/#2404 and later migrations:
   `cd ~/code/rf-prod-migrate && BACKUP_DIR="$PWD/backups" railway run --service postgres node ../rf-prod-migrate-2423/apps/api/scripts/backup-production.mjs pre-2423 && railway run --service postgres node ../rf-prod-migrate-2423/apps/api/scripts/prod-migrate.mjs; echo "exit=$?"`
   (only migration 20260927043000 should be pending). Then #2425 (20260927060000), then #2309A (20260927100000) — commands issued when each is gated.
2. **Before onboarding S2 #2431 deploys** (Mac mini, in ~/code/rf-prod-migrate):
   `railway variables --service @routeflow/api --set ONBOARDING_TOKEN_SECRET=$(openssl rand -hex 32)`
3. **Delete 92 superseded branches** (PC PowerShell):
   `$f="C:\Users\nakram\AppData\Local\Temp\claude\C--ClaudeCode-routeflow\1362094e-a512-4d01-a579-232006f0c891\scratchpad\del-branches-2.txt"; $ok=0; $bad=0; Get-Content $f | ForEach-Object { gh api -X DELETE "repos/najathakram/routeflow/git/refs/heads/$([uri]::EscapeDataString($_))" 2>$null; if ($?) { $ok++ } else { $bad++; "FAILED $_" } }; "deleted=$ok failed=$bad"`
   and the retry: `gh api -X DELETE "repos/najathakram/routeflow/git/refs/heads/fix%2Fmobile-scan-lane-e"`
   (all branches are in `local-assets/backup/routeflow-all-branches-2026-09-27.bundle`, 52 MB, verified).
4. **Stripe live cutover** — per #2448's runbook, only after #2448 + its docs follow-up land and #2446 is deployed (it is).
5. **#2436 read-only prod report** (command in PR #2446's body) and **#2452 Connect census** (script not written yet).
6. **#2079** Google/Microsoft console setup by Sep 29. 7. Units switch when you choose.
8. PC: unknown `python.exe -` PIDs 35148/44916 since 09-25 — if not yours: `Stop-Process -Id 35148,44916`.
9. **Remote Control** for the "Routeflow Lead" session is OFF after the crash (the lead can't switch it on —
   the classifier refused); switch it on from the session toolbar so the lead can message Mac/MacBook sessions.

## 5. Sessions & state (window titles)
**PC (crashed 08:15Z; lanes being brought to a safe point; lane handoffs → `local-assets/handoff/2026-09-27/lanes/*.md`)**
- Routeflow Lead — this file. Cron sweep job 2edaf3d2 (:17/:47) may have died with the app.
- RouteFlow Lane F prover — SAFE. #2448 proof PASS posted; next #2425 @d6e98be9. Only routeflow_postgres up (idle). Handoff lanes/F-prover.md.
- RouteFlow Lane U-po — SAFE (all 3 branches committed, trailer on HEAD, trees clean, nothing pushed; lanes/U-po.md). Local only, unpushed: fix/b2188-spec-windows-esm-url (Windows test fix, master merged,
  folding 2 new bare-path specs), fix/2198 ba2d7bb53 (#2241), #2185 mid-merge in rf-lane-U-po-12; next #2093,
  #2233, #2088. Safe-point msg delivered. It gets the first PC verify slot ("U-po go").
- RouteFlow MacBook bookkeeping (runs on the PC) — #2385 fix (restore apps/ + fold landings). Got "continue", NOT safe-point (msg cap).
- Native lanes P0 kit — **#2330 READY TO PUSH** feat/2330-native-theme @852ff2437649f67df21dc0233bf9c278ae548bb0 (rebased on 3b08ae06; rulings adopted; ramp pin 13/13; spec 15/15). S-scan's 1c6b8790/927f8686 are not on origin — ask S-scan (Mac) to push or list any extra pins. #2331 next, locally.
- Sales-facts product-insights API — #2240 + #2091 rebuild. Got "continue".
- RouteFlow Lane S-order — #2438 rebuild on master after #2445 (break-all + CopyButton; NO welcomeEmailDelivered field). Not reached.
- RouteFlow Lane salvage — **#2135 READY TO PUSH** fix/2110-stops-reorder-route-v2 @9e8b471f5 (bca52e8a excluded; routes 430/430). #2068 @0febb6051 merged 3b08ae06, tests pending; #2301/#2199/#1321/#1325 re-merging; **#2171 WIP is UNCOMMITTED on disk — commit it first.** All local.
- Native lanes buyer screens — #2341 guard PR A local @9f2e6ca7d2ba55e41a3afb3b5481f86bba9d47fa (unpushed); sign-up PR B waits on kit; next #2345 data layer, #2348 timeline logic (kit-independent).
- Lane messaging: the app paused the lead's session messages after 10 (anti-loop); resumes on the owner's next message here.
- PC verify order when resumed: F prover image → U-po → S-order → Sales-facts → salvage → N-kit/N-buyer. ONE full verify at a time, JEST_MAX_WORKERS=4.
- Parked: janitor --apply fix in worktree agent-a085402d5afe04912 (commit msg scratchpad/janitor-commit-msg.txt; main checkout lacks node_modules/.bin).

**Mac mini** (unreachable from the lead since the crash; last active ~12:35Z): RouteFlow Mac Lead coordination ·
RouteFlow landing coordinator (window 11:40–14:40Z) · RouteFlow SA resumption post-outage (SA-4xx) · Lane B@mac
(#2440/#2442/#2458/#2460/#2469) · S-scan@mac (#2467, #2143/#2144 next) · F2 (Mac prover) · "Extract and fix vendor-bills poTotal drift" (#2451 → then #2452 census).
**MacBook**: RouteFlow MacBook landing (#2448; needs the docs follow-up §6).
**Cloud**: B562 builder (#2445 done; #2425 re-pinned d6e98be9; #2431 draft at 52b0c881 SA-456 folds; S4 next; S2 cherry-pick after #2425). One-way messaging only.

## 6. Known issues & new follow-ups (file as tickets where no number yet)
- #2448 runbook (before owner cutover): `post-deploy-check` needs `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app`; keep test key out of shell history; what to do if re-run shows changes>0; live "send test event" may not exist → 6.3 live checkout is the proof. Optional: DB-lane case for unknown-slug abort wiring; plan digest bound to `--confirm`.
- #2465: payment-failed email embeds a short-lived Stripe portal URL (use `${FRONTEND_URL}/settings/billing`); `failedPaymentCount` not replay-safe until #2442's event ledger; put `stripeCustomerId` in the `where`; two CASes not atomic; `onPaymentSucceeded` matches customer-wide.
- #2458: downgrade cron `billing-cron.service.ts:298/262` rewrites override fee (landing condition); `subscribe()` :371/381/437 same class; upgrade guard ignores `priceOverrideMonthly` (race).
- #2467: null reissue read-back falls back to stale snapshot (:627-630); order-embedded captures don't surface parks; mobile ignores `parkedReversals`, web has no approve client.
- #2469: standalone payment Order FOR UPDATE can 40P01 vs completeWithPayment KEY SHARE (wrap `recordStandalonePayment` in retryOnTxConflict); `cancelReturnsStock` from unlocked pre-read (orders.service.ts:2590); `writeOff` unlocked read-then-write (:5375); recordPayment vs standalone WRITTEN_OFF policy mismatch.
- #2464: payment-writer coverage rule matches across closures (revert of :907 stays green); `CREATE_OTHER_CLIENT` control can't fail; sweep CAS ABA.
- #2451: prod key must read its own account (owner check); #2452 census (read-only, owner-run).
- #2433 → #2450 (replay apply-path lock + tail check) filed.
- Live tenants: two paying tenants are DO-NOT-TOUCH (no backfill/stamp/repair); slugs never in git/GitHub.
- Plane: `plane:check` trips a tenant-uuid denylist false positive on 6 old records.

- **#2093 design (U-po, lead ruling 13:25Z, owner may override):** build option (A): no schema. A non-throwing `checkLinesSellable` before the first line write gives ONE AuditLog row plus the banned lines in the response (import: per-row warnings; split: `bannedLines`, with the audit row naming the parent and children, i.e. "children inherit"). Both rows become GUARDED; PENDING_BASELINE 2→0; ENFORCEMENT_POINTS stays 12. Option (B), a persisted per-invoice `restrictedLines` flag shown on the invoice, is an OWNER QUESTION for later. Known gap to note in the PR: an invoice dated inside a since-LIFTED ban window is missed by a today-check.

## 7. Lead rules that bit today (logged via lead-closeout.mjs)
Owner commands always restated in full inline · docs PR merge-base diff over apps/packages/scripts must be empty (#2385) ·
trains before singles · post-train close linked issues · merge-only re-pin = tree identity; import-only hand hunks allowed ·
never merge on a stale/failed check · lead never merges/flips/railway-runs; owner-run prod only.

## 8. Next session — first 5 moves
1. `date -u`; `git ls-remote origin refs/heads/master`; visibility; read #938 since 13:15Z.
2. If PUBLIC past 14:40Z with no coordinator → owner flips private (§0).
3. Get Remote Control on; message Mac Lead + coordinator: land §3 queue in order #2451 → #2465 (then #2442 v2 PR) → #2467 → #2464 (then #2468) → #2433 → #2419 → #2448 → docs.
4. Get SA ruling on #2458; tier-2 PASS for docs #2244/#2408/#2412.
5. Resume PC lanes from `local-assets/handoff/2026-09-27/lanes/*.md`, one verify at a time.

## 9. UPDATE 14:50Z (supersedes §0/§3 where they differ)
- master `886fe727`, PRIVATE. Landed in the window that closed 14:19Z: #2451 049ace15 · #2448 80093f83 · #2465 214802bb ·
  #2464 e3f88cc4 · #2467 4f88f96f · #2469 886fe727 (plus #2445, #2459, #2462 earlier). post-deploy-check passed.
- Owner at ~14:35Z: "you can make the repo public and do the landings", so a NEW window is authorized. The Mac landing
  coordinator opens it when watchdog 67992 exits (~14:40Z), with a fresh 180 min.
  Queue: #2433 → #2419 (if F2/CI OK) → #2412 → #2408 → #2458 @29ca0cd2 → #2460 (cherry-picked after #2458) → #2475 @cd274ec0 → PC PRs.
- Lead verdicts posted on #938: #2458 PASS (condition met; #2460 must follow immediately) · #2475 PASS (CI owed) ·
  #2474 PASS, HELD for the migrations in strict order #2423 → #2425 → #2309A → #2474 (20260927120000) · docs #2412/#2408 PASS ·
  #2244 folded into #2385 (lessons conflict) · #2385 scope OK, rebuild after #2412+#2408 (B870 collision).
- Safe point lifted ONLY for window work: the coordinator, Lane B (#2460), bookkeeping (#2385), and PC pushes one verify at a time
  (U-po win32 fix has the slot; then #2241, #2330 N-kit 852ff243, #2135 salvage 9e8b471f5, #2438 S-order c820fae1, #2240 Sales-facts f3fcc84b).
- Every PC session now has Remote Control ON and a lane handoff in `local-assets/handoff/2026-09-27/lanes/`. Mac lanes' handoffs are in
  `.claude/handoffs/2026-09-27-*.md` on their machines (mac-lead, landing-coordinator, macbook-landing, macbook-bookkeeping, …).
- The follow-up tickets from today's Opus notes are being filed (R1.1b; the #2448 runbook fix goes to R1.1a, and it must land before the owner's cutover).
- Follow-ups filed: #2476 (billing webhook ledger claim), #2477 (inline-returns parks), #2478 (Void re-import noise), #2479 (cutover runbook fixes, R1.1a, BEFORE owner cutover, assigned to MacBook landing via Mac Lead); the rest were already in #2470-#2473. #2455 added to Project #3.
- 15:30Z: lane-lock fixes: new labels lane:returns-followups (#2143/#2144/#2477), lane:selling-restrictions (#2093), lane:credit-notes (#2404); #2452→tooling; #1470/#1924 triaged→purchasing. The code-map refresh for today's landings is owned by MacBook bookkeeping (#2385 + a rolling bookkeeping PR).
- 16:05Z sweep: master 79e4c0cc, PUBLIC (window to 17:40Z). Landed since 14:40: #2433, #2419, #2412, #2408. Lead verdicts: #2485 PASS, #2494 PASS (supersedes #2423; the migration is in prod), #2490 PASS (+ executed-proof ruling), #2496 PASS, #2434 PASS-WN, #2486 FAIL (2 folds, R-ui), tier-2 batch 5857183834; #2492 Opus running. #2458 re-pinned 165365c9.
- Blockers: the PC pushes wait on U-po's win32 test fix (slot held since 15:21Z, verify running); invoices.service ratchet 6134/6136, U-units' extraction #2498 lands first. Owner: the #2425 migration result is pending.
- Filed: #2493 (due-date follow-ups), #2495 (OAuth hardening), #2497 (.overline CSS), #2500 (wipe-tenant banner vs dialed DB, R1.1a); #2487 closed as a duplicate of #2488.
