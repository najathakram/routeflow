# Fleet lead handoff — compressed Release 1 (2026-09-22)

> **UPDATE 03:40Z — every session reads `local-assets/handoff/2026-09-22/STATE-0340Z.md` FIRST; it supersedes the task lines below (unpushed local work, the merge queue, each lane's current task, tonight's new rules).**

Written 2026-09-22 02:17 UTC (2026-09-21 21:17 CDT) for a **fresh lead session with no memory
of tonight**. Read this, the tracker artifact (`https://claude.ai/artifact/9a4AR71X1s7wZxyDFapt5z`),
and `local-assets/handoff/2026-09-22/RELEASE-LIST.md` (the owner-facing detail) before touching
anything. Do not re-derive any of this from scratch — it is all below or in those two files.

## 0. The compressed plan (owner decision, tonight)

The owner compressed the 09-19 four-lane plan: **everything the release needs must be merged
and deployed by Tuesday 22 Sep, 14:00Z (9:00 am CDT).**

- **13:00Z (8:00 am CDT), Mac mini** — release-candidate proof on ONE owner login: F2 drives
  it, every changed flow at 1440 / 768 / 390, on the Mac mini's driver.
- **13:15Z (8:15 am CDT)** — owner runs the production backup + prod migration for PR #1184
  (ledger correction columns).
- **14:00Z (9:00 am CDT)** — go/no-go.
- **Three CI windows tonight** at ~03:00Z, ~06:00Z, ~10:00Z, then the **final train ~13:30Z
  (8:30 am CDT)**.

**Merge policy:** "PASS with lows" merges immediately — low-severity findings go to a
follow-up list (kept in `RELEASE-LIST.md` §Part 6), not a blocker. **Only a correctness HOLD
blocks a merge.**

**PC load rule:** one full `verify` at a time on the PC (disk was down to 3.3 GB free, CPU
saturated). New builds go to the **Mac mini**. The **MacBook** does the regulated/returns
rework (B660, B665) and pushes directly.

## 1. State of every lane and machine (as of 02:17 UTC)

| Session title                                        | Role                                                       | Lane     | Machine                       | State right now                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RouteFlow fleet lead                                 | PC lead — rulings, bug ids, specs                          | —        | PC                            | (this session)                                                                                                                                                                      |
| RouteFlow landing coordinator                        | Lands PRs in merge windows, never builds                   | COORD    | PC                            | queue: #1163, #1202, #1121+#1189 proof, #1089                                                                                                                                       |
| Lane U-units resume and merge                        | Units of measure, steps 1–5                                | U-units  | PC                            | #1147 (unit picker on create-order) and #1148 (staff edit by unit) both open, in review/verify                                                                                      |
| Order UI redesign steps 10–11, B597/B596 (= S-order) | Order screen steps 3,8,9,10,11 + mechanical supersede duty | S-order  | PC                            | landing #982 (step 10, merged); opening the #989 supersede PR (mobile line cards v2); also cherry-picking #1119/#1120 supersedes from R-ui's fix                                    |
| RouteFlow Lane S-scan resume                         | Scanner steps 1,2,4,5,6,7 + B673/B647/B658                 | S-scan   | PC                            | #1119/#1120 fixing (stacked supersede), #1197 (B673) fixing, B647/B658 built+tested, not pushed                                                                                     |
| RouteFlow Lane F prover setup                        | PC prover — owns PC compose stack, repro-first proofs      | F        | PC                            | proving B667 (#1185), B664 (#1176)                                                                                                                                                  |
| RouteFlow Mac Lead coordination                      | Coordinates the Mac's 4 lanes, does not write code         | MAC-LEAD | Mac mini                      | routing PROOF-REQ/NEED-DB/NEED-ID, certifying the machine                                                                                                                           |
| RouteFlow Mac F2 prover                              | Mac prover — owns Mac compose stack, repro-first proofs    | F2       | Mac mini                      | proving #1121+#1189 (delivery progress), owed a UI proof on #1199 (PO totals)                                                                                                       |
| Snapshot restore and flag fixes (= Lane B)           | Backoffice/entitlements/A-items + B660/B662/B661           | B        | Mac mini                      | #1059/#1060 (A2 tail) queued behind #1114; #1180 (B662) in review; **B661 building now — the core fix the whole money-bug family depends on**                                       |
| RouteFlow R-ui restrictions rule-editor              | R1 steps 4–6 (UI)                                          | R-ui     | Mac mini                      | #1200 merged (lift-rule dialog); 3 small follow-ups todo; pushed the NaN-guard fix (`d1bc36b8`) S-order is cherry-picking                                                           |
| Senior Architect role and operating rules            | HIGH-risk design calls across the money-bug family         | —        | Mac mini (embedded in Lane B) | designed `regulatedUnitBasis` (packages/pricing) + the "convert only inside writeSaleEntries" rule + the 6-site follow-up allowlist; assigned B648–B651/B670/B674/B650 across lanes |
| RouteFlow MacBook landing                            | Push host + regulated/returns rework                       | MacBook  | MacBook                       | B660 pushed `6b828ed3` (api 7877 green), review pending; B665 building, step 1(b) done locally (425/425, scanner 1483/1483)                                                         |

**Cloud lane (CRM)** — unresponsive tonight, per the owner's note; CRM phase 1 stays blocked on
the owner's 3 questions regardless (see §5).

## 2. Every open decision

1. **CRM phase 1** — blocked on three owner answers: lead-reassignment ownership,
   upgrade-prompt loudness at the customer-limit edge, the allowed call-outcome list. Nothing
   to do until the owner answers; don't nudge below P0.
2. **PC disk cleanup** — owner OK still wanted to clear `node_modules` from merged, idle
   worktrees. Ask via the question box, don't just do it.
3. **Whether B663 (short/on-account delivery reconcile) lands by 10:00 pm CDT** — if not, it
   moves to the cut list automatically per the owner's ruling tonight (see RELEASE-LIST.md
   Part 5). No further decision needed, just track the clock.
4. **T6 final `SET NOT NULL` migration** — owner-run, not urgent tonight, scheduled for the
   week of 28 Sep; do not bundle it into tonight's migration window.

## 3. Timeline (tonight → morning), with exact owner steps

- **~03:00Z (~10:00 pm CDT)** — CI window 1. Land whatever is green: #1163 (copier contract),
  #1202 (legacy classifier), #1193 already merged. Watch for #1121/#1189 F2 proof result and
  #1089 (mobile modal errors) if it clears its "lows" bar.
- **~06:00Z (~1:00 am CDT)** — CI window 2. Expect B661 (the core fix) to be under Opus review
  around here per the Lane B plan; land it the moment it's green — everything else in the
  money-bug family leans on it.
- **~10:00Z (~5:00 am CDT)** — CI window 3. Last chance for B663 before it auto-cuts. Land the
  MacBook's B660/B665 rework if review is clean by then.
- **13:00Z (8:00 am CDT)** — **Owner logs into the Mac mini.** RC proof: F2 drives every
  changed flow at 1440/768/390 on one consistent tree.
- **13:15Z (8:15 am CDT)** — **Owner runs the production backup, then the production
  migration**, for PR #1184 (ledger correction columns) — exact commands, in order:
  ```
  railway run --service postgres node apps/api/scripts/backup-production.mjs <label>
  railway run --service postgres node apps/api/scripts/prod-migrate.mjs
  railway run --service postgres node apps/api/scripts/schema-drift.mjs
  ```
  The last command must exit 0 (no drift) before you consider the migration done. Pick a
  `<label>` that says what it's for, e.g. `pre-release1-ledger-cols`.
- **~13:30Z (8:30 am CDT)** — **Final CI/merge train.** Everything still green and merge-ready
  lands here.
- **14:00Z (9:00 am CDT)** — **Go/no-go.** If go: deploy, wait for BOTH deployments to reach
  `SUCCESS` (never flip visibility on `BUILDING`), then run `npm run post-deploy-check` against
  prod. If no-go: document exactly what's red and hand it back to the owner as a question, not
  a delay announcement.

## 4. Merge policy (verbatim, apply it consistently)

"PASS with lows" merges immediately; lows go to the follow-up list in `RELEASE-LIST.md` Part 6.
Only a correctness HOLD blocks a merge. Do not invent a stricter bar mid-run — a lane holding
its own PR past a PASS-with-lows verdict is itself a delay to flag, not a virtue.

## 5. The churn / supersede recipe (use this, don't re-derive it)

Several PRs tonight got merge-commit prettier churn on machine-written `.claude/` markdown,
which trips file-integrity checks unrelated to the actual change. **Fix: cherry-pick the real
diff onto a fresh branch from current master, open a new PR, close the old one as superseded.**
Tonight's instances, for reference (some already landed, some still open — check the live PR
list before assuming a state):

- #1143 → #1200 (**merged**)
- #1179 → #1202 (open, not yet merged as of this snapshot)
- #989 → `feat/s-order-11-rn-line-cards-v2` (branch pushed `741e1fac`; PR still needed opening
  as of this snapshot)
- #1114 → `fix/a3-tap-targets-v2` — **parked**, not urgent: its `globals.css` change trips the
  marketing-port SHA pin; ruling is to move the media query to an admin-scoped stylesheet
  instead, leaving `globals.css` untouched
- #1119 / #1120 → a combined supersede being built by S-order on the PC, based on R-ui's pushed
  fix commit `d1bc36b8`
- #1181 → `feat/b659-estimate-convert-levy-2` (PC builder, scoped and green, holding for a PC
  verify slot)
- #1197 → `fix/b673-add-item-boxes-pieces-v2`

## 6. PC load rule

Only ONE full `npm run verify` at a time on the PC — disk was at 3.3 GB free and CPU saturated
from three simultaneous verifies tonight. Route new builds and heavy test runs to the Mac mini.
The MacBook pushes its own regulated/returns work directly and doesn't run the shared verify
queue.

## 7. Standing owner rules (bind every session, every lane, always)

- Never name a live client tenant anywhere (code, tests, comments, chat, the board). Approved
  test tenants only: `test`, `e2e-routeflow`, `routeflow-demo`, `qa-*`, `e2e-*`, `ux-audit-*`.
- `railway run` needs explicit **per-call** owner approval, warned before every call — never
  implied from an earlier approval.
- Never `--no-verify` / `SKIP_VERIFY` on code changes.
- Never force-push a branch that's already been pushed — supersede with a new PR instead (see
  §5).
- **DO NOT** flip these flags: `selling_restrictions.enabled`, `credit_limit.enforce_*`,
  `ENTITLEMENT_CONFIG_SNAPSHOT`, `flag.units_v1` (the only place `units_v1` may be granted in
  production is the `test` tenant).
- Fable decides, Opus reviews, Sonnet builds.
- Fable-first on owner questions: get Fable's recommendation before bringing a question to the
  owner; present the owner only with options plus that recommendation, via the question box —
  never buried in prose.
- Refer to sessions by their **window title** (the table in §1), never an internal agent id.
- Lead output is 1–2 lines unless the owner asks for more — no status tables or relay recaps by
  default.

## 8. Incidents tonight (context only, already resolved or contained)

- A PC reviewer agent deleted 2,814 tracked files in the main checkout via bad `node_modules`
  junctions; all restored from git. The main checkout's `node_modules` is still partially
  reinstalled — expect it to need `npm ci` once disk space is free. Lane worktrees were
  unaffected. (Lesson L-180 extended with this recurrence.)
- S-scan switched a worktree's branch while its pre-push verify was still running; the run was
  killed, nothing was pushed — no cleanup needed, just don't repeat it.
- R-ui attempted a hook bypass, self-caught it, nothing was pushed.

## 9. Where to look next

- Owner-facing detail, priority-ordered, every item: `local-assets/handoff/2026-09-22/RELEASE-LIST.md`
- Ready-to-paste prompts for every lane + a new lead session + the owner's own checklist:
  `local-assets/handoff/2026-09-22/NEXT-SESSION-PROMPTS.md`
- Live tracker (source of truth for status, update via ArtifactData with `if_version`):
  `https://claude.ai/artifact/9a4AR71X1s7wZxyDFapt5z`
- Shared lane board: GitHub issue #938 (`gh issue view 938 --repo najathakram/routeflow --comments`)
- The 09-19 plan of record (sub-feature detail per card): `local-assets/handoff/2026-09-19/EVALUATION-remaining-work.html`
  and `local-assets/handoff/2026-09-19/lane-prompts/*.md`
