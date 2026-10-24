# Handoff — Lane U-units (Sonnet builder, machine pc) — 2026-09-20 ~13:00Z

Board: GitHub issue #938 (`gh issue view 938 --repo najathakram/routeflow --comments`; append
`gh issue comment 938 ... "[HH:MMZ] [U-units@pc] EVENT — detail"`). Worktree:
`C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-U-units` (cd INTO it in a separate call before
`git checkout -b`; the guard blocks `git checkout <ref>`/`switch`, use a new local branch name).

## Merged earlier

Step 1 pricing ladder (#943), 2a product-unit API (#947), 4a guard (#970), 4b-1 `resolveLineUnits` (#953),
AST inventory (#976), B587 order number (#980).

## Open PRs (all mine; the coordinator lands, I never merge)

| PR                                                                                                    | What                                                                                | State                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| #951                                                                                                  | step 2b web editor (+B594 fix cc67add7: placeholder clip + duplicate toast)         | Verify green; needs Lane F 390px re-proof (PROOF-REQ posted) |
| #993                                                                                                  | B588 + B598 lock-race tooling (10/10 under 16 burners, was 6/10)                    | Verify green                                                 |
| #1049                                                                                                 | B590 schema-folder spec derives invariants (floors 135/92)                          | Verify green                                                 |
| #1074                                                                                                 | B591 plane-doctor self-test (10/10 under 30 burners, was 8/10)                      | Verify green                                                 |
| #1086                                                                                                 | prefactor: RF-198 price-race block -> buyer-cart-price-check.ts (orders.service.ts) | private-billing red only                                     |
| #1082                                                                                                 | 4b-2a pure unit-line builder + gate (unit-line-build.ts)                            | Verify green                                                 |
| #1090                                                                                                 | 4b-2b order create() sells by a unit behind units_v1 (at 73d00c1f)                  | stacked on #1086 + #1082                                     |
| #1095                                                                                                 | prefactor: invoice manual line builder -> manual-invoice-lines.ts                   |                                                              |
| #1101                                                                                                 | 4c-1 manual invoice create by a unit (unitLabel), update() refuses a unit           | stacked on #1095 + #1090                                     |
| Landing order for the coordinator: #1086 -> #1082 -> #1090 -> #1095 -> #1101. Red Verify on new PRs   |
| with NO failing step = the private-repo Actions billing block (public-window CI per batch), not code. |

## Decisions / defaults on the board (change only if the lead says)

- Estimates, templates, import stay PACK-ONLY in v1 (EstimateItem / OrderTemplateItem have no unit
  columns = migration + NEED-DB); their AST rows stay PACK_ONLY_CREATE.
- Skip 4c-2 (invoice update by unit) for v1: a unit line is created-then-final; edits stay fenced (409).
- Unit-aware order price = ladder price at the customer's tier or the staff-typed one-time price
  (typed vs the TIER-1 unit price, like the pack branch); promos/remembered upsell = pack lines only;
  buyer portal stays on the product's default unit (buyers sending unitLabel -> 400).
- Storage: request qty COUNTS THE UNIT; stored boxes=count, pieces=0, qty=count x factor (base
  pieces), unitsPerBox=factor snapshot, unitLabel; factor-1 unit = per-piece, boxes/pieces null.

## Traps I hit (each cost a cycle)

- A scoped `npx jest <spec>` during/before a push leaves `.campaign/runs/api.json` PARTIAL and
  campaign-check rejects the push. Before pushing after scoped runs: `npx turbo run test --force
--filter=@routeflow/api` (~3 min), then push. Never run jest while a push verifies.
- `apps/api/src/common/size-ratchet.spec.ts` runs in the **repo-truth** lane (`npx jest -c
jest.repo-truth.config.js src/common/size-ratchet.spec.ts`), not default jest. Cap = baseline + 25.
  orders.service.ts baseline 6045 (cap 6070; was 6067 with 4b-2b) — master keeps growing, so a
  stacked PR can go red after a master merge. invoices.service.ts baseline 6412 (now 6386).
- `git commit ... | tail -1` hides commitlint failures (subject lowercase, <=72 chars). Read the output.
- python heredoc: `"\\r?\\n"` in a normal string mangles regexes; use chr(92) or a raw file.
- Background burner processes (`node -e "for(;;){}"`) are not killed by bash `kill` on Windows; kill via
  PowerShell (`Get-CimInstance Win32_Process ... CommandLine -match 'for\(;;\)'`).
- Shared DTO trap (worth a lesson): an optional field added to a DTO used by create AND update opens
  the update path unless it is closed in the same PR (4c-1's BLOCKER).

## NEXT: step 5 unit picker (web)

LineItemRow / CreateOrderModal (1937 lines) / invoices/new/page.tsx (2282 lines); buyer portal stays on
the default unit. Plan: 5a `UnitPicker` component + ladder hook/price helper (unused, tested), 5b wire
CreateOrderModal behind `flag.units_v1`, 5c invoices/new. Each UI PR needs a PROOF-REQ for Lane F
(1440/768/390, all states). Web pieces already on #951: `lib/api/product-units.ts` (hooks),
`lib/unit-cascade.ts`. `resolveUnitPrice` from @routeflow/pricing prices a unit at a tier client-side.
Also pending: FINDINGs on #938 (cron-lock.spec test (f) wall-clock flake; barcode-per-level; NULL-tenant
blind spots; sibling nextPoNumber/StatementNumber/BillNumber; order-templates ORD-Date.now()).
