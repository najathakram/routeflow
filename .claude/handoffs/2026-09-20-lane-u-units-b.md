# Handoff — Lane U-units (PC, Sonnet) — 2026-09-20 ~18:30Z (supersedes 2026-09-20-lane-u-units.md open-PR table)

Board #938 (`[U-units@pc] EVENT — detail`). Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-U-units`
(cd into it in its OWN call before `git checkout -b`; the guard blocks bare checkout from the repo root).

## Open PRs (mine; coordinator lands)

- #1090 4b-2b order create by unit @221a5b84 — Verify GREEN (public-window rerun). orders.service.ts 5953/5954, ZERO margin.
- #1101 4c-1 manual invoice by unit @884adda4 — Verify GREEN; pinned-asymmetry spec + invoices baseline 6390 included. Stacks on #1090.
- #1116 real-Postgres unit-ladder db spec @dfa67261 (base = #1090 branch) — NEVER EXECUTED (PC docker has no running postgres); NEED-DB posted. Opus static review done, 3 fixes in. First real run may need a fixture tweak. flag.units_v1 must stay OFF until it is green.
- #951 step 2b web editor (needs Lane F 390px re-proof) · #993 B588/B598 lock tooling (Verify green).
- #1118 5a UnitPicker + buildUnitOptions, UNWIRED, base = #951's branch (land #951 first). Branch feat/u-unit-picker-5a.
  Landed since last handoff: #1086 #1095 #1082 #1049 #1074.

## Tooling bugs

B588/B598 = #993 (open). B590 = #1049, B591 = #1074 (landed). Nothing else owed.

## NEXT

- 5b (picker in CreateOrderModal behind flag.units_v1) BLOCKED on #982 (S-order, same region). Feed the picker the EFFECTIVE tier
  (`CustomerPrice.pricingTier ?? customer.pricingTier`), `packPrice` = the price the row already shows, distinct `ariaLabel`;
  model MAX_LINE_QTY/MAX_LINE_SUBTOTAL in the qty editor; buyer portal stays on the default unit.
- 5c invoices/new: PREFACTOR first (extract manual-line slice, characterization test), then wire; stacks on #1101+#1118. MarginHint must
  get cost-per-UNIT (pack cost x factor/upb) so the below-floor warning fires for unit lines. Needs PROOF-REQ for F/F2 (1440/768/390, all states).
- Skip 4c-2, estimates/templates/import stay pack-only (see prior handoff).
- Lesson candidates to mint (bookkeeping): a DTO field shared by create+update opens update unless closed in the same PR; a db spec outside tsconfig/eslint is only gated by its own lane — pin claims with negative halves (overflow) and instanceOf, not typeof; a client picker must be pinned to the server resolver by an agreement spec; stale held value must be reset via onChange, never masked.

## Traps

- Scoped jest leaves .campaign/runs partial -> before pushing run `npx turbo run test --force --filter=@routeflow/web` (or api); never run jest while a push verifies.
- A Monitor `until` matching the previous commit's subject fires immediately — match the NEW subject.
- Commit hooks take 1-3 min; run commit/push in background and wait for the notification. Never `git add -A` (hook junk agent-log.jsonl/approach-rotation.json); explicit pathspecs.
- Read tool: use the WORKTREE path, not the main checkout.
