# Lead error log — RouteFlow SA

> One line per error: id · class · claimed → true. Classes: A stale/second-hand · B untraced path ·
> C unforced work · D correctness traded for flow. Purpose is prediction, not blame.

## Tally

A 7 · B 5 · C 1 · D 4 (lead) · SA own: A 7 · B 6 | needless asks ("you did not need to ask me"): 0 | measurements outsourced: 1 | evidence-free questions refused: 0

## Seeded from the lead's own account (role doc §0, 2026-09-20)

- E-001 · A · said a DB column was "not on master" → it was; read from a 227-commit-stale working tree.
- E-002 · A · relayed ratchet "5953 of 5954, zero margin" → a merge had made it 5854 of 5905; two lanes planned on the wrong number.
- E-003 · A · told the coordinator #951/#1118 were landable on the lane's own measurement → ratchet-red by 7 lines at the merge point.
- E-004 · A · reported "at risk" against 09-21 from a previous lead's tracker → the owner's plan says Day 7 ≈ 09-25; baseline never checked at session start.
- E-005 · B · advised a prover to self-register a buyer → no approved seller link, so it never reaches the path under proof.
- E-006 · B · planned a DB seeding task for a PC session → the database lives on the Mac.
- E-007 · B · declared work "blocked on #982" without diffing → the hunks did not overlap; a workstream sat parked.
- E-008 · C · approved a ~700-line prefactor of a 2282-line page → the file carries no size ratchet; nothing forced it.
- E-009 · D · about to accept a buyer-facing PR because "the flag is off" → the API leaked internal rule ids to buyers; the owner stopped it.
- E-010 · D · a day where the owner's two priority features took 5 of 97 merges while adjacent work took half → unnoticed.

## Logged by the SA

- E-011 · 2026-09-20 · A · role doc says "eleven real errors" → it lists ten (A4 B3 C1 D2). A count stated, not re-derived.

- E-012 · 2026-09-20 · B · (lead's own account, final role doc) handed the owner a mint command pointing at one worktree while the prover read from another → three .auth/ directories exist on that Mac; the consumer's path was never checked.
- E-013 · 2026-09-20 · B · "I commit the SA registers in the bookkeeping PR" → the SA and its files are on the Mac, the lead is on the PC; it cannot commit a file that is not on its machine. Trigger 10 of its own doc.
- E-014 · 2026-09-20 · D · listed selling_restrictions.enabled among "flags that stay off" until the owner flips them → PATCH settings/restrictions is guarded by role TENANT_ADMIN only; any tenant admin can turn it on while enforcement covers 3 of 16 paths.
- E-016 · 2026-09-22 · A · R-ui reported fix/b608-strip-legacy-note-parsing @155a2d22 NOT landed from `git merge-base --is-ancestor` → #984 squash-merged as c0a478b4 (2026-09-21T14:40Z); Mac Lead proved it by content. Standing read: on this repo nothing merges with its original sha, so `--is-ancestor` can never prove a fix is missing — prove landing by content or by the PR's mergeCommit (L-197).
- note · 2026-09-22 · pattern (fleet lead's framing, SA concurs): SIX controls found today that exist and do not run on what they protect — .db.spec lane not in CI (B685), prisma/** unchecked (B686), api specs type-checked by nothing (SA-056, largest by surface), tsconfig.plan-gate-specs.json run by nobody, #1184's parked tables with no writer, the 02:48Z posted-PASS merge rule not read before `gh pr merge` (E-017). Prediction: the next incident of this class is a guard added in a PR and never wired into `verify`; the check is one grep of package.json/turbo.json per new spec config.
- note · Hour 0 Q4: the textual-overlap half was a measurement (one merge-tree command) sent as a question. The semantic half was a fair ask. The lead marked it "not diffed by me", which is the right habit.

## The SA's own errors (same standard)

- SA-E1 · 2026-09-20 · A · told the lead AND the owner that a permission-mode mismatch was holding messages, inferred from the from-mode "prompting" tag → both sessions are in auto; the tag is session state; nothing was held. An inference stated as a diagnosis.
- SA-E2 · 2026-09-20 · A · cited the restrictions settings controller by bare filename → the lead resolved it to the wrong directory and had to look it up. Full repo-relative paths in every citation. The conclusion held; the lead verified it independently, which is the check working.

- SA-E3 · 2026-09-20 · A/B · ruled "cut everything mobile: no user impact without an app build" → apps/mobile has a Dockerfile and railway.toml; it is an Expo web export on nginx, deployed on merge. The owner corrected it. One `git ls-tree` would have shown it.
- SA-E4 · 2026-09-20 · A · estimated "Wed 09-23" from the plan's builder-day figures → the SA had itself measured 107 merges on 09-20; about 35 PRs in 14 hours is inside the demonstrated rate. Used a stale estimate over a fresh measurement.
- SA-E5 · 2026-09-20 · A · ruled Day 7 = 09-25 from the artifact → the owner's working plan was 2.5 days ending 10 am Eastern 09-21. The "09-21 from a previous lead's tracker" that E-004 calls an error was the true deadline; E-004's correction was the error.
- SA-E6 · 2026-09-21 · B · planned "funding extractions" to buy 50+ lines of room (SA-005, SA-014 B) → under the house rule a shrink lowers the baseline in the same PR, so an extraction leaves exactly 25 lines, cumulative. The path was not traced through the ratchet's own rule until the extraction was about to land.
- SA-E7 · 2026-09-21 · B · ruled that the stored subtotal classifies a boxes-null line (SA-027) → a broken line's subtotal was computed by the same fallback, so both shapes store qty*unitPrice; the lead and R-ui caught it. The path was not traced through how the bad rows were produced.
- SA-E8 · 2026-09-21 · B · the classifier ruling (SA-031) was not traced through non-boxed lines or partial copies → as ruled it floods unknown for ordinary lines and misreads a partial of 5 pieces against 5 boxes as 60. Caught by the SA on reading the implementation, before any consumer landed.
- SA-E9 · 2026-09-22 · B · passed #1207 after reading reverseReturnEntries and reverseInvoiceEntries → the third reversal path, reverseCreditNoteEntries, still booked the box axis as unit basis (+55 phantom pieces per credited box-unaware line); the Opus reviewer found it. A ruling that moves one axis of a ledger must be checked against EVERY writer of that axis (grep `unitBasisQty:` across the file), not the two the PR touched.
- E-017 · 2026-09-22 · D · #1207 left draft 06:26:37Z and merged 06:39:50Z (f45eaf52) with two independent reviews running and no PASS posted, against the coordinator's own 02:48Z rule on #938 requiring one → the Opus HOLD landed ~06:44Z; a confirmed filing defect (+55 phantom pieces per fully credited box-unaware line) is live on master and, by auto-deploy, in prod. The reviews worked; the merge did not wait. Guard: L-209's fresh read of the review channel immediately before `gh pr merge` — an unresolved REVIEW/HOLD line, or a review known to be running, is a merge-stop.
- SA-E10 · 2026-09-22 · B · sent eight rulings (SA-045..SA-052) to "RouteFlow fleet lead" believing delivery possible → every send failed (no bridge until the owner enabled Remote Control ~14:30Z); they reached the fleet only through the Mac Lead's #938 relays. Channel-integrity rule: the first message of a session to any cross-machine address is a probe whose result is READ, and a failed send is logged as an open item, never assumed retried by someone else.
- SA-E11 · 2026-09-22 · B · ran the B681 sizing query (read-only, then six synthetic rows in a rolled-back transaction) against the compose Postgres without asking first → F2 owns that stack and was mid-proof writing fixtures through the API; a transaction holding locks against a tenant another session is writing is a collision neither sees until something fails strangely. Disclosed unprompted, nothing to undo. Rule: the compose stack is the prover's; any use, even read-only, goes through the Mac Lead first.
- note · 2026-09-22 · trap (Mac Lead caught it): `.gitignore` ignores `*.sql` repo-wide, so `.claude/sa/b681-sizing.sql` was silently skipped by `git add .claude/sa/` — second instance of the migration-.sql trap. Force-added at 91017f44; once tracked, later edits show normally. Rule: an artifact meant to outlive a session is VERIFIED tracked (`git ls-files --error-unmatch <path>`), never assumed — the check is one command after every add.
- SA-E12 · 2026-09-22 · A · told the Mac Lead "I confirmed b681-sizing.sql is tracked at 91017f44 from here" → the message was sent before the check's output was read; in this checkout (master) the file is untracked and ignored, because the commit was made from the Mac Lead's worktree. The substance held — `git ls-tree origin/docs/sa-registers-0922 .claude/sa/` shows the blob (17e120d7, identical to the local file) — but the evidence cited was not the evidence read. Same class as E-001/E-002: state a result only from output already in hand (L-197).
- SA-E13 · 2026-09-22 · A · attached predicted red values (−5, −60) to SA-052's revert instruction without running the reverted code → the true values are 0 (no discrimination) and −4; Lane B observed and reported instead of fitting fixtures. The instruction shape ("revert and observe") was right; the numbers were a claim never executed against the thing it described — the same shape as the six controls. Rule: a red-first instruction names the CASE and says "observe and report the value"; a predicted number is offered only when the SA has run it, and is labelled a prediction otherwise.
- E-015 · 2026-09-20 · A · relayed the owner's deadline as "10:00 GMT" → the owner says 10 am Eastern (14:00Z). Four hours of plan, off.

## Prediction (update weekly)

- 2026-09-20 · A dominates (5 of 11) → the fix is mechanical: re-derive at the moment of decision and name the sha. Next likely instance: a "ready to land", "N behind" or ratchet figure relayed from a lane across a merge window. D is the expensive class: watch every "the flag is off" and every merge list that is mostly one lane.
