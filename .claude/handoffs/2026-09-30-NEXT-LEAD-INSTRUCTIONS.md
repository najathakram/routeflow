# NEXT LEAD — start here (written 2026-09-30 ~03:10Z by "Routeflow Lead" [1b6054], Opus 5.5, PC)

The owner is moving the lead seat to another Claude account (100% weekly usage available; the old account is at 91%).
You are the new **"Routeflow Lead"**: you decide and route, you never build. Owner quote for this handoff:
"do all your work properly … Use strong agents to evaluate implementation, based on the user experience and the user's requirements. Give them high flexibility and a smooth process. Whatever we do, we do them right!"

## 0. First 15 minutes (in order)
1. Read `.claude/skills/fleet-lead/SKILL.md`, then this file, then `.claude/handoffs/2026-09-30-lead-card-*.md` (the newest), then
   `local-assets/handoff/2026-09-29-owner-return.md` (the owner packet) and `local-assets/handoff/2026-09-30-owner-feature-gaps/00-SUMMARY.md`.
2. `ListAgents`. Announce yourself to every live lane: "Routeflow Lead is now [<your ref>] on the new account; report to me."
   Live lanes at handoff: **PC**: RouteFlow Lane salvage, RouteFlow Lane U-po, RouteFlow bookkeeping, RouteFlow Lane F prover, Native lanes buyer screens (N-buyer),
   Native lanes P0 kit (N-kit). **Mac mini (Remote Control)**: RouteFlow Mac Lead coordination, RouteFlow landing coordinator, RouteFlow Mac F2 prover,
   RouteFlow SA (architect), Lane B, Lane U-units. **MacBook**: offline (M4a, MacBook landing).
3. Arm `CronCreate` usage checks (`7,27,47 * * * *`, get_usage) plus a 40-min checkpoint (visibility PRIVATE, master sha, disk). The lead is COMPACTED, never cleared or deleted; after any compaction, re-announce your address to every lane.
4. Verify every id or sha you relay with `gh`/`git` output (memory: verify before instructing). The verdict board is **GitHub issue #2554**. Post comment bodies with `--body-file` (backticks in `--body` get shell-evaluated).

> Lane handoff cards (2026-09-30-<lane>.md) may sit UNCOMMITTED in each lane's own worktree (e.g. N-kit's is in the n-kit worktree), not in the main checkout. Find them with `git worktree list` + a search for `.claude/handoffs/2026-09-30-*.md` under each worktree, or ask the lane.

## 0b. LANE ROSTER (ready-to-paste per-lane prompts + model/effort: 2026-09-30-LANE-START-PROMPTS.md) + HOW TO MATCH YOUR LANES (read before assigning anything)
The old fleet's lanes are below. **Your account may show different session names, or fewer or more sessions.** Lanes are ROLES, not names:
match each of your sessions to ONE role below by its machine and domain, hand it that role's card (all cards are now in `C:\ClaudeCode\routeflow\.claude\handoffs\2026-09-30-*.md`; the Mac ones are on the Mac mini in the same path), and tell it "you are now <role>; read your card; report to me".
Rules: one session per role; one owner per hot file (the collision map below); a role with no session → park it and tell the owner which machine to open a session on; never give two sessions the same card. If a role's card is missing, the lane's worktree (`git worktree list`) + its open PR are the truth.

| Role (old name) | Machine | Domain / owns | Card | State at handoff → next |
|---|---|---|---|---|
| Lead | PC | decides/routes, never builds | NEXT-LEAD-INSTRUCTIONS + lead-card-0510Z | you |
| Mac Lead coordination | Mac mini | relays to the Mac + MacBook lanes; Mac-side decisions | mac-lead.md (Mac) | live; knows every Mac sha |
| Landing coordinator | Mac mini | CI windows (watchdog → public → merge → PRIVATE), carries | coordinator card (Mac) | runs the landing list |
| F2 prover | Mac mini | Docker/Colima proofs, DB lanes, Playwright captures, drift gates | f2 card (Mac) | next: the bundle portalVisible DB spec + captures; the final drift gate after STEP 0; the #2762 guard re-run; the #2792 prefs HTTP check |
| SA (architect) | Mac mini | rulings/pins (SA-6xx on #2554) | — | the bundle SA-603 series; delta reads |
| Lane B | Mac mini | settings pages (settings/page.tsx + SettingsHub owner), auth folds | lane-b card (Mac) | #2792 Settings PR-1 @7bcc18f8 (needs SA + Opus + F2); #2486 second-lander after #2765 |
| U-units | Mac mini | catalog.prisma / products.service.ts / orders.service.ts (until D4) owner; M3; the Sitting-B bundle; reuse; families | u-units card (Mac) | the bundle LOCAL @81fb7918 (waits STEP 0) → the portalVisible code → reuse API → #2784 → families |
| MacBook M4a | MacBook | web product/analytics pages; CSV (#2790) | m4a card (MacBook) | #2790 lands; next = WS3/WS7/WS8 web per MASTER-PLAN |
| MacBook landing | MacBook | tooling/guards (#2762); next = WS10 credit notes | landing card (MacBook) | #2762 lands; then credit notes #2400 family |
| U-po | PC | PO domain + the layout.tsx nav owner | u-po.md | #2781 lands; PR-A2 (the PO nav leaf + Supplier Bills) in progress → A3 → #1407 → the PO detail page |
| salvage | PC | import.service.ts + messaging/*/email/* API owner | salvage.md | #2185/#2785 land; next = the staff email feature (approved plan) on the bundle |
| N-buyer | PC | buyer screens, buyer-catalog.service, order-stock.ts (from D2) | n-buyer.md | #2737 @e099626d + #2793 @0b8f2220 need Opus; next #1337 (drop its migration) → sell-unavailable |
| N-kit | PC | UI kit, web notification page, native driver | n-kit.md | #2765 lands after Sitting A; next the notification page (#1965/spec 10) |
| F prover | PC | PC Docker proofs, DB lanes, bug-pipeline builds | f-prover.md | #2791 ruled redirect-to-order → assign the build |
| bookkeeping | PC | tickets, board (Project #3), Plane (only via plane:apply/sync), docs PRs | bookkeeping.md + bookkeeping-pc.md | first batch = MASTER-PLAN §8 |
If you have MORE sessions than roles: give the extras MASTER-PLAN workstreams with no owner yet (WS14 cleanup, WS12 bugs, the #2791 build, the Google monitor move) — never a second owner of a hot file. If FEWER: keep Lead, the landing coordinator, one prover, SA, U-units (critical path: bundle → reuse → families), salvage (email), then U-po (POs); park the rest in that order.

## 1. Standing rules (owner)
- Weekly usage ladder: 90% handoff cards · 95% nothing new starts · 98% next-lead prompt · 99% stop all safely + confirm the repo PRIVATE.
- Classifier/permission denials are NEVER routed around (no asking another session to do what one was denied). Surface them to the owner.
- Model routing: planning/verdicts Opus 5.5 @ high; builders Sonnet 5.5 @ medium (never low for code); every task gets an Opus review; F2 (Mac) / F prover (PC) run DB lanes, Docker proofs and Playwright captures.
- Test-first planning for every owner ask (the cases that prove the perfect implementation come BEFORE any build).
- Landing: public CI windows only when the owner authorizes (currently until **04:30Z 2026-09-30**); the coordinator runs a watchdog (≤ 45 min) first, fresh CI per landing, and flips private as a `finally`. Never merge on a stale or failed check.
- Migrations: the owner runs prod migrations himself (backup → prod-migrate → drift 0) from a clean dedicated checkout (the Mac mini `~/code/rf-prod-migrate-m2` pattern), never from a main checkout. Migrations apply in FOLDER order. Squawk + `BEGIN; SET LOCAL lock_timeout '5s'; …; COMMIT;`.
- Three live paying tenants: nothing writes their rows without the owner's explicit approval; never put their slugs or names in git or GitHub.
- UI work: Playwright proof at 1440/768/390 on test tenants, all states; RouteFlow design system; no raw error/status strings in the UI (owner, 2026-09-30).

## 2. State at handoff (verify, it moves)
**UPDATED 2026-09-30 ~05:05Z (the old lead at 97% weekly):**
- master = **de2d61c2** (windows 6–8 landed #2664, M2 #2741, #2774, #2771, #2769, #2776, #2782, #2778). The repo is PRIVATE. Standing windows (owner): ~13:00Z + ~01:00Z daily, 60 min each, + one after each sitting.
- **Prod migrations applied:** M1, **M2** (02:20Z, drift 0, 5902764597). **SITTING A is in progress / next with the owner**: checkout `~/code/rf-prod-migrate-A` @4bf48d9c (Mac mini, clean; #2554 5904474147); sha256 M3 5bc06fca…, handoff 9d9ac81f…, Apple abdab977…; the lead gave the owner the step-by-step (link → pending check shows exactly 3 → STEP 0 → backup pre-sitting-a → prod-migrate → drift 0). Confirm with the owner whether it ran.
- **STEP 0 (owner, read-only)** is still needed for Sitting B: the pg_indexes Product name index names + the 2 active-name dup counts (/tmp/rf-step0.sql on the Mac). U-units puts the real names into the bundle's DROP INDEX IF EXISTS, then F2 re-runs the gate on the final sha.
- **13:00Z window order (all lead-PASS at these heads, #2554 5905079044 / 5905106196):** #2185 @fe47f9a7 (squash) → #2785 @29742f33 (RETARGET to master after #2185, confirm a 4-file diff) → #2781 @9e990275 → #2762 @7b1ae33e (closes #2783) → #2790 @62f6db25 (CSV export, F2 READY) → after Sitting A is confirmed: M3 #2754 @2e6fbf16 (#2780 folded; state 3 dropped from the capture gate → #2791) → #2765 @d0b05fa3 (needs HANDOFF_TOKEN_SECRET set first) → #2486 @abe494c1 (needs the APPLE_* vars; SECOND-LANDER checklist on #2554 5905121005: the 6-arg AuthController etc., Lane B) → #2779 @3eff1354. #2764 @18863f55 needs the SA-595c delta + the owner's iPhone scan.
- **Sitting B bundle** (U-units, LOCAL feat/sitting-b-schema-bundle @d9ce5a18, folder 20260929220000; SA-603/603a/603b/603c): portalVisible, retired* code-release columns, ProductBarcode.code nullable + retiredCode, the active-only name partial uniques (STEP 0 gated), EmailDelivery (+contentFingerprint), PolicyValue (folded from #1337), NotificationEvent += STAFF_NEW_ORDER / BUYER_ORDER_EDITED / BUYER_ORDER_CANCELLED. F2 gate PASS on v1 (5903601258); re-run on the final sha. Target Sitting B ~Sun 10-04.
- B894 prod census: all zero (5902802633).
- Tickets filed today: #2783, #2784, #2786, #2787 (mobile settings parity), #2788 (one staff-claims builder), #2789 (the acme placeholders, folded into the bundle), #2791 (a draft invoice edit "doesn't persist" = by design, the order is the source of truth until delivery; RULED redirect-to-order web guard, #2554 5905187345; assign a builder).
- **Lanes at handoff:** U-po = PO-A2 (the nav leaf + Supplier Bills rename + ?tab=) → A3 (scan intent) → A1 #1407 → the PO detail page; M4a = CSV done (#2790) → next per MASTER-PLAN WS3/WS7/WS8 web; salvage = the email feature (approved plan: STAFF_ORDER_EMAIL env off|dark|on, per-user opt-outs, buyer edited/cancelled staff emails, EmailDelivery writers; stacked on the bundle); N-kit = the notification page redesign (spec 10 / #1965) against salvage's API; N-buyer = #2737 fold3 → #2653 v2 → #1337 (drop its migration + model, now in the bundle) → sell-unavailable (policy key per SA-602); Lane B = Settings PR-1 (IA + search + banner + route defaults + digest pref; operators READ-ONLY on selling rules; credit-limit waits for #1337/Q9); U-units = the bundle → portalVisible code (SA-603, spec 06, hidden parent hides variants, bulk + filter) → reuse API → #2784 → families (a non-sellable container); F prover = #2791; MacBook landing = #2762 nits → WS10 credit notes; F2/SA/coordinator as usual.

## 3. Owner rulings 2026-09-29/30 (binding)
- Scan: a distinct unit code adds a UNIT, a box code adds a BOX, a shared code adds the product's default sell unit.
- **#2780: a plain buyer qty = the default selling unit** (the customer's default if one ever exists, else the product's default set by the tenant), identical on every buyer path. SA-601 pins it (resolveLineUnits; explicit boxes/pieces win). Known gap: the tenant's `isDefaultSelling` isn't honoured anywhere yet, so #2784 covers the picker + scan + buyer qty.
- #2762: merge allowed, with the 20 s speed bar waived (#2783 follow-up).
- `~/code/routeflow-clean` (Mac): KEEP. 171 unpushed branches are bundled at `local-assets/routeflow-clean-review/` on the Mac; a per-family supersede check is due before any delete (the owner decides).
- Next owner sitting: M3 + handoff migrations, EAS 1.2.0 build (set EXPO_PUBLIC_GOOGLE_MAPS_API_KEY in EAS first), #2764 phone scan.
- **2026-09-30 rulings:** Q4 DB-enforced one-active-holder (SA-603 release design); Q5 names follow; Q8 staff new-order emails to all active admins, 1 week dark then on; Q11 EmailDelivery 90 d, full to admins, masked to operators; standing CI windows 2×60 min/day; FREEZE the Native 2.0 buyer/operator restyles (driver only); Sitting A today, B ~10-04; new families = a non-sellable container; rename "Bills & Purchasing" → "Supplier Bills"; scan-to-PO locked on LITE (manual POs free); operators see selling rules read-only; R1.2 bug scope = critical + P1 + high touching money/stock/tenancy.
- **Still to ask the owner (MASTER-PLAN §7):** Q6 standing orders vs out-of-stock, Q7 hiding restricted items (a read-only count first), Q9 credit-limit Off/Watch now, Q17 B2230 VALIDATE, Q18 spec 52 by F2, Q20 turn staff emails on for the complaining tenant, Q21 delete nightly/post-deploy/deploy-production workflows, Q22 the Google sign-in monitor → Railway cron, Q23 the 45k native lines after the 1.2.0 soak, Q24 cleanup confirmations. Also: the owner asked to keep rf-work (the GitHub Project #3 board) + Plane current. The work-board scheduled task needs the OWNER to run (the lead was classifier-denied): `Rename-Item C:\ClaudeCode\rf-work-runner rf-work-runner.stale-20260928` then `powershell -NoProfile -ExecutionPolicy Bypass -File C:\ClaudeCode\rf-work-reconcile-clean\scripts\work\install-scheduler.ps1 -Ref origin/master -Plane`. The board/Plane actions are listed in MASTER-PLAN §8 (bookkeeping executes; Plane only via plane:apply/sync/work:plane-release).
- **Cleanup:** 4 read-only audits in `local-assets/handoff/2026-09-30-cleanup-audit/`; the approach = knip + a CI ratchet, small reversible PRs after the hot files calm (MASTER-PLAN WS14). The Google sign-in monitor never runs while private (the Actions billing block), so move it (Q22).

## 4. THE BIG WORK: the owner's feature gaps (his words: "most of them I know you worked on. But I don't see them working yet.")
Specs, test-first, one per gap: `local-assets/handoff/2026-09-30-owner-feature-gaps/` (00-SUMMARY + 01…10 + 09-open-questions). Summary of the research (origin/master, 2026-09-30):
1. **Purchase orders**: BUILT (manual create/edit/receive, raise-PO from a scanned bill) but hidden as a tab inside Inventory with no nav entry. Fix the discoverability and polish; check the scan-to-PO gates (flag.ap_bills dark, ocr add-on dark).
2. **CSV export** for analytics / product details / product stats: NOT BUILT (only orders, invoices, payments and finance reports export). #2119 (the product insights page) is open.
3. **Variant families**: M1/M2 foundations live; M3 pending; the family-first create/edit UI (the "flavors matrix") was never ticketed; `mixed_packs` is off for all tenants.
4. **Deactivate + SKU/barcode reuse**: NOT BUILT. Hard `@@unique([tenantId, sku|barcode|unitSku])` blocks it; it needs partial unique indexes on active rows (mind CONCURRENTLY vs the transaction wrap) + a reactivate conflict flow.
5. **Sell unavailable items** (tenant opt-in): NOT BUILT (hardcoded: staff oversell with a warning, buyers get a 409).
6. **Buyer-portal / state / category restrictions**: BUILT (Settings → Compliance → Selling restrictions / Product labels, admin-only) but the master switch is off by default and hard to find; there's no per-product "hide from buyer portal".
7. **Settings with no UI**: credit-limit enforcement, the low-stock digest, route defaults, price tier labels. The owner wants every configurable feature exposed meaningfully in tenant settings.
8. **A live tenant's admin gets no emails**: order-status emails go to BUYERS only, and there is NO admin order email; the low-stock digest needs a TENANT_ADMIN role + reorderPoints; failed sends aren't persisted. The owner runs `email-diagnostic.sql` (same folder, read-only) against `test` vs the failing tenant.
9. **Notification matrix UX** (owner screenshot): raw "Not available: no transport configured" in every cell, which the owner calls ugly. Redesign it; add an app-wide rule against raw strings.
**THE STRATEGY IS `local-assets/handoff/2026-09-30-owner-feature-gaps/PROGRAM-PLAN.md`** (waves, lanes, collision map, migrations, definition of done). Execute it.
Run it as a program: an Opus product/UX lead per gap refines the spec with the owner's intent; the SA pins the rules; Sonnet builders go test-first; Opus reviews for correctness AND user experience against the owner's words; Playwright proof; then the landing. Ask the owner the 09-open-questions via the question box, with recommendations first.

## 5. Owner-blocked items (keep them visible to him)
M3 / handoff / Apple migrations; the EAS 1.2.0 build (Maps key); the #2764 iPhone scan; running email-diagnostic.sql; the `work board` scheduled task on the PC was DISABLED 2026-09-30 (its runner checkout `C:\ClaudeCode\rf-work-runner` is gone, and it popped a "cannot find run-hidden.vbs" error every 5 min). Rebuilding the runner is a ticket; re-enable it with `Enable-ScheduledTask -TaskName 'RouteFlow work board'` only after the runner exists.
- **Awaiting the new lead's Opus delta:** #2737 @e099626d5abfc2e694e020025dfc7a635ac58e52 (N-buyer fold3 over the FAIL 5901449482: any-spawn scope, per-spawn env, mutant pins, verify-scope comment); #2793 @0b8f222061f040549fdcd26cf3cdbd18c2f2ddaf (#2653 PR-2: web Google + PWA hide, cut on master de2d61c2). #2690 was CLOSED by N-buyer with patch-id evidence (3c9d039f, 682c6bb9); drop it from the window lists.

## FINAL STATE (old lead at 98% weekly, all Mac/MacBook lanes STOPPED clean; PC lanes paused with cards)
- **New deltas owed by the new lead (Opus, then land at the 13:00Z window):**
  - #2790 @dca41bc6 (vs the PASSed 62f6db25; 2 web files; F2 verify 5906399327);
  - #2762 @ac5896c19241d74fe7dbee92f7cba2da85248e10 (vs the PASSed 7b1ae33e; the 3 nits: `.length` writes unresolvable, export let/var resolve, the no-op removed; 54/54; F2 guard re-run owed; 5 behind master, so the coordinator updates it);
  - #2792 Settings PR-1 @7bcc18f8549c161c1eca8ca08522b331f7420180 (Lane B; SA-602a prefs allow-list: lowStockDigestEnabled/pushEnabled/locale en|es/bill.lastSupplierId/payment.lastMethod; unknown keys → 400; spec 31/31; needs the SA delta + Opus + an F2 prefs HTTP re-check);
  - #2737 @e099626d and #2793 @0b8f2220 (my review agent for these did NOT finish; re-run it).
- The Sitting-B bundle is LOCAL @81fb7918 (U-units: + portalVisible stages 1–4). F2 was STOPPED before the heavy portalVisible job (a bundle-migrated compose + the DB spec + Playwright); it's on F2's card. The final drift gate comes after the owner's STEP 0.
- U-po was resumed on PR-A2 (the PO nav leaf); check its card/commits.
- Salvage never confirmed its pause: check its card (.claude/handoffs/2026-09-30-salvage.md) and worktree.
- **NOTE 15:51Z:** the 13:00Z window did NOT run (the fleet was stopped at 98%). The new lead runs that landing list as its first window (the owner authorized standing windows ~13:00Z/~01:00Z). Repo PRIVATE, master de2d61c2, verified 15:50Z.
- **Lane Q&A at handoff (answered by the old lead):** #2792 locale en|es accepted (ticket: derive from a shared LOCALES); depot lat/lng null-clear → a ticket; SA-580a / the per-customer default / widened SA-580c are all already owner-ruled (buyers keep the product default; customer default if one exists else the product's; #2784); #2417/#2182 are NOT in the bundle (a later sitting); F2's first job = capture #2792 as a TENANT_ADMIN (seed one on a qa-* tenant); the #2779 quote-strip unit-only pin is accepted. MacBook landing wants the OWNER's yes to delete 12 stale MacBook worktrees. Window 9 (owner-authorized ~15:55Z): #2185 carried @20b47125, CI running when the old lead stopped; check the coordinator's card for the result.

## OWNER REQUESTS CHECKLIST (2026-09-29/30): every ask → where it's specified → who owns it → state
Specs live in `local-assets/handoff/2026-09-30-owner-feature-gaps/` on the PC ONLY (gitignored). **The Mac/MacBook lanes can't read them: relay the relevant spec section in your message** (or paste it into their card) when you assign the work.
| # | Owner ask (his words, short) | Spec / plan | Owner lane | State |
|---|---|---|---|---|
| 1 | POs visible in the admin/operator UI; a scanned invoice → a PO, editable later; POs without invoices | 01-purchase-orders.md, WS2 | U-po | built but hidden; PR-A2 nav in progress; rulings: "Supplier Bills" rename, scan-to-PO locked on LITE |
| 2 | Export analytics, product details and stats to CSV "then and there" | 02-csv-export.md, WS3 | M4a | #2790 landing (final window) |
| 3 | Streamlined variant families (one family, variants under it) | 03-variant-families.md, WS8 | U-units (API) + M4a (web) | after M3 + bundle + reuse; FAMILY = a non-sellable container |
| 4 | Deactivate an item; reuse its SKU/barcode if only one active; reactivation asks to deactivate the holder | 04-deactivate-and-code-reuse.md, WS7, SA-603/603a/603b | U-units + M4a (dialogs) | in the Sitting-B bundle; names follow the rule (Q5) |
| 5 | Tenant switch to sell unavailable items | 05-sell-unavailable-items.md, WS9 | N-buyer | not built; policy key (SA-602) after #1337 |
| 6 | Hide products from buyer portals; restrict by state; stop categories in states — "we don't see the control knobs" | 06-buyer-portal-restrictions.md, WS6 | U-units (portalVisible) + Lane B (discoverability, PR-1) | restrictions BUILT (Settings → Compliance, off by default); portalVisible in the bundle; operators read-only (owner) |
| 7 | Expose every tenant-configurable feature meaningfully in tenant settings | 07-settings-without-ui.md, WS5 | Lane B (#2792 PR-1) | in review; credit-limit waits for #1337/Q9; mobile parity #2787 |
| 8 | A live client's admin gets NO emails (inventory/order) | 08-email-notifications.md + email-diagnostic.sql, WS4 | salvage (API) + N-kit (page) | owner runs the read-only diagnostic; staff emails 1 week dark then on (Q8); EmailDelivery 90 d (Q11); Q20 = turn it on early for that tenant |
| 9 | "This is ugly" — no raw error strings in the UI | 10-notification-matrix-ux.md | N-kit | not built; an app-wide guard + 7 sites |
| 10 | A careful codebase cleanup without breaking anything | cleanup-audit/{api,web,mobile-packages,tooling-docs}.md, WS14 | extra/least-loaded lanes | audits done; knip + a CI ratchet; the 45k native lines only after the 1.2.0 soak (Q23) |
| 11 | Keep rf-work (Project #3) + Plane current with the plan | MASTER-PLAN §8 | bookkeeping | 4 tickets added; §8 batch owed; the runner reinstall = OWNER command |
| 12 | A fastest, optimized plan with lanes, minimal migrations, no waste; evaluate + improve value | MASTER-PLAN.md (+ the lead reconciliation) | lead | done; 2 sittings total (A now, B ~10-04) |
| 13 | Strong agents evaluate the implementation vs the user experience + his requirements, with high flexibility | quality bar (lead prompt) | lead | an Opus UX evaluator per workstream at its last UI PR |
| 14 | Use 100% of all 3 machines (PC, Mac mini, MacBook) | standing load permission | lead | owner 2026-09-30 |
| 15 | Remote Control ON for every RouteFlow session | — | each session (the owner flips the switch where a lane declines a relayed toggle) | the lead + Mac Lead + SA on; F2/Lane B/U-units need the owner's switch; the PC lanes queued; N-buyer needs the owner |
| 16 | Standing CI windows; freeze the Native 2.0 restyles; sittings A today / B ~10-04; R1.2 bug scope | rulings §3 | lead / coordinator | ruled |
- **Final window, live update 16:10Z:** #2185 LANDED a92d79287cad27c1b08ab70b9cc4cab17041eb9d (deploy SUCCESS 16:09Z). **#2785 SKIPPED**: after the retarget it carried #2185's pre-squash commits (73 files) and conflicts. Salvage must REBASE #2785 onto master a92d7928, cherry-picking ONLY its own commits (the 4 import files: import-columns.ts, import.service.ts, import-invoice-money-2190.spec.ts + .db.spec.ts), push, then fresh CI + a quick lead delta (the tree content = the reviewed 29742f33 4-file patch). #2781 carried @3d46f9a7, then #2762, #2790: check the coordinator's result.
- **STOP 16:13Z (100% weekly):** the repo was PUBLIC with the final window open; the coordinator was told to finish only #2781 then flip PRIVATE + read back (the watchdog also flips it ≤45 min after ~16:00Z). **New lead: verify PRIVATE first.** #2762 @ac5896c1 and #2790 @dca41bc6 (lead PASS) go to your first window; #2785 needs salvage's rebase first.
