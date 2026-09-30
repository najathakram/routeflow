# F04 — build plan

**Status: APPROVED for execution** · worktree `.claude/worktrees/rf-F04`, branch
`fix/F04-pricing-mirrors` off `master 77a8c058` · dev-pipeline Workflow, scale **major**.
Money batch: the close-out adds the standing **Fable adversarial pass over the final diff**
before the PR opens (house rule; not part of the Workflow).

## P1 — the api mirror (reference implementation)

- **satisfies:** R1 R2 R3 R5 R7 · **provenBy:** T-B122 T-B109 T-B50 T-G3
- **Files (owns exclusively):** `apps/api/src/common/pricing.ts`, `apps/api/src/common/pricing.spec.ts`
- roundMoney per R2's exact body. applyBestPromotion per R3 (bill-basis comparison via
  computeLineSubtotal; read the ctx it already receives — boxes/pieces/unitsPerBox are in
  scope at the call sites). ADD `prorateLineSubtotal(stored, delivered, ordered, freeUnits=0)`
  implementing the telescope — READ `invoices.service.ts:827-897` first and port the arithmetic
  exactly (that file itself is untouchable — F03's lane).

## P2 — web + mobile mirrors (byte-mirror P1)

- **satisfies:** R4 R7 · **provenBy:** T-G3 · **dependsOn:** P1
- **Files (owns exclusively):** `apps/web/lib/pricing.ts`, `apps/mobile/lib/pricing.ts`
- Mirror P1's changed/new functions byte-for-byte (modulo each file's existing import/typing
  frame). Mobile's existing `prorateLineSubtotal` is REPLACED (signature gains the defaulted
  `freeUnits` param — source-compatible per R7).

## P3 — mobile callers + tier-ladder parity

- **satisfies:** R5 R6 · **provenBy:** T-B50 T-G3 · **dependsOn:** P2
- **Files (owns exclusively):** `apps/mobile/lib/short-pick.ts`,
  `apps/mobile/app/(driver)/route/stop/[stopId]/payment.tsx`,
  `apps/mobile/app/(driver)/route/stop/[stopId]/short-pick.tsx`,
  `apps/mobile/lib/api/orders.ts` (additive `OrderItem.unitsPerBox?` only),
  `apps/mobile/__tests__/short-pick.test.ts` (or the existing home of its tests)
- Pass each line's freeUnits into the proration; fix `short-pick.ts:69-87`'s docstring to be
  true again. The driver review screen (`short-pick.tsx`) must map ShortPickLine identically
  to `payment.tsx` since both feed the same `reconciledTotal`. Tier ladder: touch
  `apps/api/src/utils/pricing.ts` and its web/mobile twins ONLY if the parity table exposes a
  divergence — otherwise they enter T-G3 read-only.

## P4 — the parity spec (G3)

- **satisfies:** R4 R6 · **provenBy:** T-G3 · **dependsOn:** P2
- **Files (owns exclusively):** `apps/api/src/common/pricing-parity.spec.ts`,
  `apps/api/src/common/pricing-parity.fixtures.ts`
- The spec imports the web and mobile mirrors by **relative path**
  (`../../../web/lib/pricing`, `../../../mobile/lib/pricing` — verify depth from the
  spec's location; they are dependency-free pure modules, ts-jest compiles them standalone —
  if jest's rootDir confines imports, add a moduleNameMapper entry in apps/api's jest config
  scoped to this spec's aliases rather than relaxing rootDir globally). Fixture rows carry a
  derivation comment each (the decimal arithmetic, worked by hand).

## P5 — promo-ctx adoption at the billing call sites (added at Gate & Review)

- **satisfies:** R3 R7b · **provenBy:** `orders-promo-bogo.spec.ts` REG-B109 · **dependsOn:** P1 P2
- **Files (owns exclusively):** `apps/api/src/orders/orders.service.ts`,
  `apps/api/src/orders/orders-promo-bogo.spec.ts`,
  `apps/web/app/buyer/portal/[seller]/cart/page.tsx`,
  `apps/web/app/buyer/portal/[seller]/shop/_components/tile-pricing.ts`,
  `apps/mobile/lib/buyer-cart-pricing.ts`, `apps/mobile/lib/catalog-tile-logic.ts`
- P1's `ctx.boxes/pieces/unitsPerBox` are OPT-IN (`hasFullQty`), and no package owned a call
  site — so the R3 fix shipped inert and B109 still billed. P1's note that "boxes/pieces are in
  scope at the call sites" is true of `resolveBuyerLinePrice`'s five CALLERS but false at its own
  signature, which took only `qtyPieces`/`qtyUnits`: it gains a 7th defaulted `denomination`
  param, threaded from all five. The four client sites pass the same split they already bill
  with, so tile/cart previews keep matching the server to the cent.

## Pipeline args

`scale: 'major'` · workdir rf-F04 · testPackages TP1 (api pricing.spec additions plus the parity
spec and fixtures) and TP2 (mobile short-pick/prorate tests) · redGate `-t "REG-B(50|109|122)"`
in both jest homes, expect fail · verify perRound: api tsc; final: api jest (JSON artifact),
mobile jest (JSON artifact), web tsc, mobile tsc, campaign-check --batch F04. Mutation targets:
roundMoney (restore EPSILON), applyBestPromotion (restore qtyUnits basis), prorateLineSubtotal
(drop freeUnits), and P5's denomination pass-through (null it at `resolveBuyerLinePrice`) — each
against its `-t` scope. No uiVerify (no UI surface).

## Manual verification

(none — all T1)

## Close-out checklist

1. **Fable adversarial pass over the money diff** (house rule for money batches).
2. Ledger F04.jsonl: B50/B109/B122 → `proven` with the jest JSON artifact; buildPlan field set.
3. `campaign-check --batch F04` green · code map (pricing entries in api/web/mobile area files,
   plus the P5 promo-ctx call sites) · CHANGELOG bullet · \_meta replace · HANDOFF campaign line.
4. Register chips + republish `310ae33a…`; guide money articles → flag to owner if user-visible
   totals change wording.
5. Merges in W3 AFTER F02b (lane-disjoint but the window is shared); `post-deploy-check` +
   `feature-smoke` (its S-money sections exercise these paths live).

## Close-out addendum (inline fix round, 2026-08-31)

- P1 ownership extended: scripts/repair-integrity.mjs + scripts/feature-smoke.mjs (their local roundMoney copies carry R2's body — reviewer-verified byte-equivalent); P4 ownership extended: apps/api/tsconfig.build.json (fixtures excluded from nest build).
- Final-pass major FIXED: basisQty cap in all three mirrors + CAP fixtures (mutation-proven). Over-delivery pin deliberately re-contracted (never bill above stored).
- roundUnitCost (web+mobile) moved to the decimal-string body + FP-victim pins covering BOTH copies.
- B109 mutation re-proven against the FINAL tree (4 red under inverted selection); the run-time escape was mid-pipeline staleness.
- ⚠️ HANDED TO F03's LANE: the server oracle (invoices.service.ts buildInvoiceItemData) may share the uncapped freeUnitSize-region over-billing — F03 discovery MUST verify and fix in-lane (note added to its card).
