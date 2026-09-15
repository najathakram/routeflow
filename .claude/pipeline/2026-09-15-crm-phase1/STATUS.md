# CRM cloud session status

**2026-09-15 ~20:40Z** · session `routeflow-62` · reporting branch `feat/crm-phase1` · slice branch
`feat/crm-phase1-core` · run dir `.claude/pipeline/2026-09-15-crm-core-phase1/`

**Engine in use: `02d58b81…`, 224,133 B, `node --check` passes, worktree clean.** Not `b71f6c8e`.

| Stage | State |
|---|---|
| S0 triage | done — `s0-triage.md` (+ addendum recording all your rulings) |
| S0.5 context pack | done — `context-pack.md`, 8,191 B (cap 8,192) |
| S1 discovery | **done — PASS, narrowed** — `discovery.md` |
| S2 spec | next |
| S3 UX · S4 tests · S5 build plan | after S2 |
| S6 approval | **your "S5 approved" gates every code push** |

## S1 outcome

**PASS, but narrowed into an option with a kill criterion rather than a six-phase commitment.**
The reframe: "we need a CRM" is solution language; the cause is that **RouteFlow has no record
for a business that is not yet a customer** — `Customer.userId` is required and unique, so every
Customer is a login and everything before the first order lives off-product.

- **Success signal**: share of RouteFlow's own live prospects held in `routeflow-hq` as a
  `CrmLead` (OPEN/QUALIFIED) with a dated next step ≤ 14 days. Baseline **0 of N**; target ≥ 90 %
  in 30 days plus ≥ 1 real conversion. Read by one read-only SQL query **you** run on prod —
  never this pipeline.
- **Kill criterion**: **< 50 % at 30 days → Phase 2 does not open.**
- **Recorded honestly**: no tenant incident triggered this, there is no deadline, and "no paying
  tenant asked for it" is carried as assumption A5 rather than argued away. Four items are
  marked *Frappe-because, not rep-because* and S2 is told to keep each minimal: pipeline-stage
  probability on leads, `CrmLeadSource` as a table, `CrmSettings`, and the `Message`-thread union.
- The rejected alternative is on the record too: nullable `Customer.userId` or a PROSPECT status
  on `Customer` — rejected because `Customer` owns tier, terms, consent, address, soft-cap, grace
  and every customer-scoped denominator, so a prospect parked there leaks into all of them.

**One reviewer correction applied before commit.** Fable's Q3/A7 said your key convention forbids
a `flag.crm` plan flag. It does not: that rule governs grantable **addon** keys, whereas plan
flags are an already-dotted namespace — all seven `DARK_PLAN_FLAGS` entries are dotted
(`plan-flag.guard.ts:21-29`), plus `flag.msrp` outside the set. The conclusion (addon gate only)
is unchanged, but it is now a **choice**, not a constraint, so S2 does not inherit a false limit.

## Questions (none block S2 starting; all three want answering before S5)

- **Q1 — Has `routeflow-hq` (Phase 0 T12–T15) actually merged to master?** `plan.md` §5 sequences
  Phase 1 after it and nothing in the repo confirms it. If it has not, the dogfood target moves.
- **Q2 — Your off-system prospect count N.** Needed for the §6 baseline; only you or the owner can
  state it. Without it the signal is "0 of unknown", which is vacuous.
- **Q3 — Does nav want a second gate (`flag.crm`) beside `crm_core`?** My recommendation: **no** —
  one grantable key is simpler and the addon gate already drives screen visibility.

Still open from earlier rounds, in `LEAD-REQUESTS-R2.md`: **#12** (no phone normaliser exists —
may I add the first one, and where), **#13** (`withAdvisoryLock` has no CRM family; the allow-list
is closed — borrow `order-merge` keyed on lead id, or add a `crm` family), **#14** (the L-113 /
L-115 citation).

## Compliance

No code written. No bug or lesson id minted. No host-heavy step attempted. No PR. Nothing pushed
beyond docs. Test-tenant policy and the no-live-client-identifier rule observed throughout.

Housekeeping: `LEAD-REQUESTS.md` holds rounds 1–1b (#1–#11); **round 2 onward is in
`LEAD-REQUESTS-R2.md`** — split per round because each MCP push must re-send the whole file. Say
the word and I will fold it back.

Also: the repo's own `stop.mjs` hook reserializes `.claude/campaign/bugs/B388.md` and `B389.md`
(`tags:` whitespace) on every turn, so every session here produces spurious diffs. I revert it each
time rather than carry it into the CRM branch — flagging in case you want it fixed at source.
