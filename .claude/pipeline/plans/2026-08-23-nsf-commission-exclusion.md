# Plan: exclude NSF fees from the commission base (owner decision 2026-08-23)

> Status: IMPLEMENTED (pipeline wf_ebeee896-1cc clean; Fable money-pass PASS). This file is the ONLY context implementers receive. No migration.

## Objective

An NSF bounce fee is appended as an ad-hoc `InvoiceItem` ("NSF fee — returned check…",
`invoices.service.ts setCheckStatus` ~L4560+) and bumps the STORED `Invoice.subtotal`/`total` —
so once the customer repays, the agent earns commission on the penalty fee. Owner decision:
**agents must not earn on NSF fees.** Exclude them from the commission base.

## Verified facts (do not re-derive)

- `commission-math.ts commissionBase(s)` (~L21): `goods = max(0, s.subtotal - s.discount)` — reads
  the fee-inflated stored subtotal.
- The ONLY marker of an NSF line is its description, written solely by the server:
  `` `NSF fee — returned check${…}` `` (`invoices.service.ts` ~L4565). `productId` is null but
  that is not unique to NSF lines.
- `InvoiceMoneyState` is built inside `commission-engine.service.ts` (find where subtotal/discount/
  total/cashCollected/creditApplied are loaded — read the file; it may or may not already include
  invoice items in its query).

## Design (locked)

1. New exported constant in `commission-math.ts`:
   `export const NSF_FEE_DESCRIPTION_PREFIX = "NSF fee — returned check";`
   `invoices.service.ts setCheckStatus` builds its description FROM this constant (import it) —
   writer and reader share one source so the marker can never drift.
2. `InvoiceMoneyState` gains `nsfFees: number` (Σ `qty*unitPrice` of items whose description starts
   with the prefix; in practice qty=1). `commissionBase` becomes
   `goods = max(0, s.subtotal - s.discount - s.nsfFees)`.
3. The engine's state builder loads the invoice's NSF lines (add items to its existing query with a
   `startsWith` filter, or filter loaded items) and fills `nsfFees` (roundMoney).
4. **`collectionRatio` is deliberately UNCHANGED**: the fee stays in `total`/collectible, which
   slightly UNDER-releases payable until the fee is paid — the conservative direction; never
   overpays. Put this rationale in a comment on `collectionRatio`.
5. Credit-note pre-tax scaling in `commissionBase` keeps using `goods` AFTER the NSF subtraction
   (the fee is not goods; a credit against the invoice should scale against real goods).

## Work package

### WP1 (files: `apps/api/src/sales-agents/commission-math.ts`, `apps/api/src/sales-agents/commission-math.spec.ts`, `apps/api/src/sales-agents/commission-engine.service.ts`, `apps/api/src/sales-agents/commission-engine.service.spec.ts`, `apps/api/src/invoices/invoices.service.ts`)

Implement the design exactly. Specs (money to the cent):

- $100 goods @10%, bounce adds $25 fee, fully repaid → accrued stays **$10.00** (was $12.50).
- Invoice with no NSF lines → byte-identical base to before (regression pin on an existing case).
- `commissionBase` with `nsfFees` covering the whole subtotal → base 0, never negative.
- Engine state-builder spec: an invoice whose items include one NSF-prefixed line and one normal
  line fills `nsfFees` with only the fee amount.
- `setCheckStatus` still writes a description that `startsWith(NSF_FEE_DESCRIPTION_PREFIX)`
  (extend an existing check-lifecycle spec assertion if one covers the description).

## Acceptance criteria

1. The $25-fee scenario accrues $10.00 exactly; the no-fee path is unchanged.
2. One shared prefix constant; no duplicated string literals.
3. `collectionRatio` untouched except the rationale comment.
4. No migration, no DTO/API surface change, full gates green.

## Verification commands (from the worktree root)

```
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-nsf && npm run check-types
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-nsf && npm run lint
cd /c/ClaudeCode/routeflow/.claude/worktrees/ap-nsf && npm run test
```
