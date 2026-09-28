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
> 6. **SECURITY census (#2538 landed 6cf5a141; read-only, SA-499 + lead Opus confirmed: a read-only session, 2 SELECTs, anonymised output).** Mac mini Terminal, once the Mac Lead reports ~/code/rf-report-2533 ready:
>    `cd ~/code/rf-prod-migrate && railway run --service postgres node ../rf-report-2533/apps/api/scripts/report-2533-product-image-keys.mjs; echo "exit=$?"`
>    It prints anonymised tenant labels and counts of product rows holding a foreign image key. If any are found, the scrub is #2544 (a separate, owner-approved write).
> 7. **OWNER DECISION (#2556, hourly markOverdue cron):** it ships DARK (disabled plus a dry-run count). Its FIRST enabled run persists OVERDUE on every past-due SENT invoice across ALL tenants, INCLUDING the two live paying ones, Traced: NO email, dunning, webhook, late fee or credit-hold fires; the only customer-visible change is the buyer app's invoice status label reading "Overdue" (buyer counts already use the due date). **The flag name is superseded by SA-506a (22:05Z correction): `OVERDUE_SWEEP_MODE` = `off` | `dark` | `enforced`, default `dark` (count + log per-tenant ids, no write; an unknown value → dark + a warning).** `enforced` is yours to set on the Railway api service. On return: review the dark-mode per-tenant would-change counts in the api logs, then say yes or no to `enforced`.
> 8. **OWNER DECISION (#2566, landed):** should VOID invoices also block a customer delete? Today DRAFT and VOID are deletable; every other status blocks (SA-510). VOID invoices are audit trail. Your call; not a blocker.
> 9. **OWNER DECISION (#2587, SA-516):** "Cleanup imported customers" (`DELETE /customers/cleanup-imported`) selects every customer WITHOUT an ACTIVE buyer link, including hand-created ones, not just imports. Options: (a) add a real import marker so it deletes only imports, or (b) rename the action to what it does. The money-record guard on both bulk deletes is being built anyway (MacBook, tier 1).
> 11. **Mac mini, unblock native captures (#2592 kit A; F2 blocked 22:40Z):** Expo CLI can't find the Simulator. Either run `sudo xcode-select -s /Applications/Xcode.app` in Mac mini Terminal (a system setting, so agents won't), or say OK to downloading Expo Go on the simulator. #2571 does NOT wait on this (no standalone render; lead PASS); #2592 does.
> 14. **Lane hold (#2417 credit-notes API, P1, assigned to you, no open PR):** it holds `lane:invoices`, so the claim tool refuses #2070 (sev-high over-billing on concurrent partial invoices) and #2612 (the same class in createSplitInvoices). Is #2417 actively being built? If not, release the lane (or relabel) and MacBook takes #2070 (tier 1, CAS inside the create tx, real-PG race pin). Also: agents' gh tokens lack `read:project`, so Mac lanes can't read Project #3. Adding the scope is your account change.
> 13. **BLOCKING: onboarding train migrations (#2425 S1 → #2431 S2).** All four onboarding PRs are lead-PASSed (with nits) but HELD: #2425's client reads `User.lastLoginAt` on every login, so merging before migration **20260927060000** is in prod would fail every login. Order: backup, then prod-migrate 060000, then schema-drift 0 → land #2425 → prod-migrate **20260927070000** + set `ONBOARDING_TOKEN_SECRET` (≥32 chars) → land #2431 → #2454/#2489. The lead posts the exact per-migration commands (they need a checkout at each PR head) once you say go.
> 12. **OWNER DECISION (onboarding S5 #2489, raw-file retention):** the purge deletes raw intake files only 30 days after a case goes LIVE. Files on LOST (abandoned) cases are kept forever, and they hold customer personal data. Purge LOST cases too (after N days)? Your call.
> 10. **READ-ONLY census (#2575, POD keys; after it lands):** Mac mini Terminal, `cd ~/code/rf-prod-migrate && railway run --service postgres node <checkout-with-#2575>/apps/api/scripts/report-2542-pod-keys.mjs; echo "exit=$?"` (the lead posts the exact checkout path once it lands). Anonymous labels and counts only.
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
- 17:20Z sweep: master cd172506, PUBLIC. Landed 16:05–17:15: #2458, #2490, #2502 (win32, unblocked the PC), #2501 (invoices slice), #2485, #2385, #2494, #2503, #2513. PC pushes flowing via pc-slot (Sales-facts #2240 in flight).
- Open gates: #2511 (my delta WITHDRAWN; F2 latch fix needed, then head-green + revert-red), #2508 (delta PASS; SA re-pin + CI), #2510 (F2 Expo proof), #2506 (FAIL, 2 folds; rebuild on #2503), #2486 (FAIL, 2 folds), #1189 + #2390 queued. #2425 HOLD for the owner's 060000 migration.
- Owner list additions: the #2500 live-wipe option A vs B; a deferred read-only legacy-PO sizing report (SA-489, #1924 closed).
- 17:57Z sweep: master 180d45b2, PUBLIC. Landed since 17:20: #2390, #2517, #2475. Lead verdicts this hour: #2511 PASS (F2 executed), #2516 PASS, #2508 executed-proof ruling, #2523 PASS (t2), #2518 FAIL (TZ spec a no-op under jest + DST), #2515 FAIL (cancel stock uses the unlocked order), #2519 FAIL (updatePlan vs unlocked reconcile; SA asked), #2240 HOLD (re-merge onto #2503 + 2 exact fixes). Opus on #2431 running.
- pc-slot made FIFO (queue tickets) after Sales-facts took two turns in a row; PC queue: U-po, salvage, S-order, N-kit, N-buyer. Filed #2524, #2525; #2520/#2522/#2524 added to Project #3.
- 18:48Z sweep: master 83af2398, PUBLIC. Landed 17:55–18:40: #2511, #2516, #2492, #2526, #2510. #2535 re-pinned 61c3c87f (tree-identical). pc-slot fairness fixed (FIFO + 45 s cooldown); N-buyer now holds it.
- Lead verdicts since 17:57: PASS #2518 delta (DST sweep 0 mismatches), #2535, #2240 delta, #2536 (then SA-498a fold), #2532 delta, #2523; CONDITIONAL #2538 (tripwire fold, then F2 probe); FAIL→PASS #2526. SA-500: filed-period immutability → #2541. New security: #2533 (in #2538), #2542 (POD traversal). Tickets: #2539, #2540.
- Owner (on return): #2425 migration output still pending; #2538's census command after it lands; #2500 option A/B; the legacy-PO sizing report.
- 19:24Z sweep: master 6de215a8, PUBLIC. Landed 18:45–19:17: #2535 (orders slice), #2240, #2538 (SECURITY), #2518. pc-slot rotating fairly (N-buyer → S-order → U-po; 4 queued). #2545 re-pinned 5ec815e3 (tree-identical).
- Verdicts since 18:48: PASS #2538 delta, #2547 (SECURITY), #2545, #2515 (final, on F2 revert-red); CONDITIONAL #2519 (F2 revert pending); FAIL #2528 (deadlock with upgrade(), upheld SA-503a → sibling #2551 first), #2546 (1 fold). Owner: the census command for #2538 is ready (top of file).
- 19:51Z sweep: master 32106033, PUBLIC. Landed 19:20–19:46: #2545, #2547 (SECURITY POD), #2515. Board #2554 (13 comments; #938 capped). pc-slot v3 (handoff to oldest live ticket, dead-ticket pruning) after FIFO v2 was bypassed by pre-v2 pollers.
- Open gates: #2555 (+2 downgrade writers fold) → #2528 (delta clean; PASS once #2555 lands); #2556 FAIL (B1 ships DARK default=count, B2 drop PARTIAL, B3 explicit-tenant tz; lands after #2536); #2519 conditional on F2; #2536/#2553 complete pending CI; #2557 invoices slice (U-units) before #2556.
- PC: U-po's #2241 and S-order's #2438 pushes did NOT reach origin (the pre-push likely failed); asked U-po; S-order re-queued with a stale-Prisma fix.
- 20:33Z sweep: master ef271b0e, PRIVATE. Lead PASSes on #2554: #2564 123cb158, #2555 f542ba30 (F2 observed 40P01), #2561 27da5547 (after a FAIL: buyer IDOR plus guard order), #2556 55a128c4 (lands after #2564). The coordinator was asked for a window in that order. #2559 needs a spec-only fix (SA-474c). #2562 needs the salvage fold (SA-425b status-race pin plus ratchet 3126).
- Filed #2563 (staff/driver bare-id line delete) and #2565 (buyer diff reverts invoices before the 403), both queued for U-units. #2566 (customer delete, tier 1) Opus review running. #2566 and #2567 added to Project #3. #2532's image proof moved to the Mac F2.
- pc-slot v4: v3's handoff deadlocked the v2 in-memory waiters, and v2 age-pruned long waiters' tickets. Fixed (liveness by PID, --since); lanes re-queued in their original order. Lesson logged. N-kit holds the slot for the #2330 push.
- 20:51Z sweep: master ef271b0e, PUBLIC (window 20:41Z to 23:41Z, watchdog 1554). Gated: #2564 0a567233 (tree-identity 9f83cf25), #2555, #2561, #2559 4e31bffa (lead delta + SA-474e), #2556 after #2564. #2568: lead PASS-with-nits, PC F prover proof pending.
- #2566: lead FAIL at 07ce4794 (data loss on master CONFIRMED; DELETE /customers/all by OPERATOR). e35abb0b meets SA-510 (WRITTEN_OFF) but not SA-510a (in-tx re-check + scoped deletes); MacBook asked; the file is at its cap of 3332. #2563 built (SA-511), #2565 next for U-units. Owner Q: should VOID invoices block customer delete?
- pc-slot: N-buyer's and S-order's --since tickets were pruned by exiting v2 pollers; restored by hand. v4 now self-heals a missing ticket. Queue: N-kit holds → N-buyer → S-order → U-po → salvage → F-prover.
- 21:28Z sweep: master f7f92241, PUBLIC. Landed this window: #2564, #2555, #2559, #2561 (#2561 via tree-identity a24f91ad + SA-507d). Lead PASSes (CI-pending): #2556, #2566 f095bfba (F2 race owed), #2568 (PC F proof owed), #2571, #2546, #2575, #2574 (after #2573), #2532 (F2 PASS). #2578 (#2560) Opus running.
- #2573 lead FAIL: an id-less CANCEL strikes off every line (Prisma drops id:undefined in updateMany); U-units folding; SA re-look asked. Filed #2577 (substitute/unit-edit bare-id siblings). Lesson logged: an update→updateMany conversion must assert every where-key is defined.
- pc-slot: S-order reused an old --since after its turn and jumped the queue. --since is now ignored if the lane has acquired since. Queue: U-po holds, then S-order, salvage, F-prover, N-kit, N-buyer.
- 21:51Z sweep: master 7e59b42b, PUBLIC (window to 23:41Z). Landed since 21:28Z: #2566, #2523. Lead PASSes this sweep: #2578 (land before #2528, duplicate retryOnTxConflict import), #2580, #2582 (tier-2 rec), #2573 fold 8187a035 (F2 9/9 + reds; push 9f429df6 per SA-511g lower-of), #2556 d1e633cb tree-check. #2241: content PASS, but it conflicts with master in 2 specs; U-po is merging.
- Lessons logged: merge-tree must be read by EXIT CODE (a tree prints even on conflict); updateMany where-keys must be defined; scratch checks never commit (Lane B --no-verify, never pushed). Filed/added: #2577, #2579, #2583 on Project #3.
- pc-slot: salvage holds (#2562 fold); queue F-prover (#2568, then #2574 proofs), N-kit, N-buyer, S-order. Owner Q still open: should VOID invoices block customer delete?
- 22:21Z sweep: master e1805008, PUBLIC (window to 23:41Z). Landed since 21:51Z: #2573, #2556, #2532. Lead PASSes this sweep: #2584 fold f06e5a6b (F2 parallel case discriminates), #2586 ac38f602 (tree-identity; F2 SA-510h probe owed), #2589 (the #2579 behavioural race spec; F2 run owed), #2592 (kit A, stacked on #2571), #2562 (F2 independent PASS).
- Filed #2587 (bulk-delete: 'imported' selects unlinked customers; CN/payments/advances unguarded). SA-516 splits the guard (MacBook) from the import marker (owner item 9). Owner-return list items 8-10 were added, and item 7's flag name was corrected to SA-506a OVERDUE_SWEEP_MODE.
- pc-slot: N-buyer holds (#2345); queue S-order, U-po (#2241 master merge), salvage (#2068), F-prover (#2574 proof; #2573 has landed, so #2574 can land after its proof), N-kit (#2332a). Lane B: #1534 after the #2584 fold (SA-515 option A).
- 23:00Z sweep: master 31b1e18d, PUBLIC (window to 23:41Z). Landed since 22:21Z: #2589, #2586, #2584, #2573, #2568. Lead verdicts this sweep: #2593 fold ffd5098d PASS (Google token carries canActAsDriver; tri-state compare), #2595 PASS (tier-2 rec), #2594 FAIL (breaks master's #2589 race spec via an InvoicePayment fixture; SA-516e upheld; MacBook folding), #2598 FAIL (CopyButton shows 'Copied' on a failed write of a client pay link; S-order folding).
- CI-only and waiting: #2593, #2595, #2575 (tree-checked by the Mac Lead), #2580, #2582, #2571, #2546, #2562, #2578 (before #2528). #2574 is waiting on the F prover's run (queued behind salvage). #2592 waits on owner item 11 (Mac xcode-select).
- pc-slot: U-po holds (#2241 master merge); then salvage, F-prover (#2574), N-kit, N-buyer. pc-slot now prints a prisma-generate reminder on ACQUIRE (N-buyer's stale-client trap).
- 23:31Z sweep: the window closed PRIVATE at 23:29Z (16 landed, incl. #2578, #2594, #2575; post-deploy green at 341e5e82); the next window opens after watchdog 1554. Lead: #2528 fold 528ae8f9 PASS (only the dedup import hunk); #2601 FAIL (a collapsed section captures a hidden return draft; dead Resolve/Cancel on INLINE rows).
- #2574: the PC F prover found its db.spec RED at head, the base dependence the lead Opus predicted (it predates #2561/#2573). F is re-running on a master merge; U-units must merge master before landing. The onboarding train (#2425/#2431/#2454/#2489, Cloud B562) had NO lead verdict at its re-synced heads; 3 Opus reviews launched.
- pc-slot: F-prover holds (#2574 proof); queue N-kit, N-buyer, S-order, U-po, salvage (#2562 SA-512c re-merge pending).
- 00:25Z sweep: master f3e3454b, PUBLIC (window to 02:41Z). Landed since 23:41Z: #2593, #2571, #2580, #2601. Lead verdicts: #2603 PASS (SA-517 item 4 folded; F2 pre-proof at the same sha), #2613 PASS (roundMoney newBase; F2 owed), #2598 fold PASS, #2610 PASS, #2611 PASS, #2609 PASS-with-nits (tx-as-non-first-param still missed), #2606 FAIL (hand-written BadgeStatus; the fold is local), #2607 tree-carry at 0723ec6f.
- #2425 lead PASS but HARD HOLD (logins fail if merged before prod migration 060000). The onboarding train is F2-proven. Owner items 11-14 added (Mac xcode-select, LOST-case file retention, onboarding migrations, #2417 invoices lane hold). MacBook on #2284 (#2070/#2612 blocked by #2417's lane).
- pc-slot: U-po holds (#2185); salvage had 2 tickets (asked to drop #2068's). pc-slot now refuses a second live ticket per lane. #2574 waits on F-prover (queued behind salvage).
- 00:54Z sweep: master 65a1fd34, PUBLIC (window to 02:41Z). Landed since 00:25Z: #2574, #2601, #2607, #2609. Lead verdicts: #2615 PASS, #2616 PASS, #2617 PASS (the tripwire non-first-param tx closed), #2185 PASS on money plus 2 folds (the dryRun fail-open; a real-PG dryRun-writes-nothing case), #2602/#2582 tree-carry. #2236: the lead brief was WITHDRAWN (SA-393 already on master); the lead skill gained 'never brief from a title'.
- Bookkeeping debt: 38 landings since a1ef8e7 are unmapped; the PC F prover authors one docs-only map+lessons PR from #2554 comment 5861422328, landing at the next window's tail. The board move to #2554 is now broadcast to all PC lanes (U-po had hit #938's cap).
- pc-slot: salvage holds (#2562 re-merge); queue N-kit, N-buyer, S-order, F-prover, U-po. MacBook: #2236 → (A) SA-393 pin + close; #2070/#2612 blocked on #2417 (owner item 14).
