# F07 · Build plan

**Status: IMPLEMENTED — proven, pending merge** · Workdir: `C:\ClaudeCode\routeflow\.claude\worktrees\rf-F07` (branch
`fix/F07-order-lifecycle-stock-conservation`, cut from master `df1ef9a3`). Scale: major.
Read `spec.md` for R#s, `test-plan.md` for T#s, `ux-spec.md` for the two copy surfaces.

**Standing rules for EVERY agent (from the campaign, verbatim constraints):**

- NEVER run `npx playwright test` in ANY form, including `--list` — it destroys
  `.campaign/runs/web-e2e.json`. Spec 27 is authored only.
- Test tenants only in any example/spec data (`test`, `e2e-routeflow`, `qa-*`, `e2e-*`); never
  a real client name. Money math only through `pricing.ts` helpers (`roundMoney`).
- Scope is EXACTLY B10/B56/B64/B65/B105/B108/B116. B208 (manual price on buyer merge) is in
  this file region and is NOT to be touched. Do not edit `settleStockForEdit`'s body, the
  transition matrix, or any F03/F06 behavior — reuse them.
- The repo formatter is Prettier (root `prettier.config.js`); `npx prettier --write <file>`
  per touched file.

## Work packages (disjoint by file ownership)

### WP-API-ORDERS — orders.service.ts + orders.module.ts (B56/B64/B65/B105/B108-order-side/B116)

`satisfies: R1,R2,R4,R5,R6,R7,R8,R9,R10,R11,R13,R14,R15,R16` · `provenBy: T1-T4,T6-T16,T19,T20`
Files: `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.module.ts`.

1. **B56 — `cancelImpact` (~:2648) + `assertCancellableOrThrow` (~:2707):**

```ts
// inside cancelImpact, after the invoices query:
// B56 (REG-B56): delivered goods block a cancel — the same signal
// settleStockForEdit already refuses to treat as returnable.
const activeLines = await this.prisma.forTenant().orderItem.findMany({
  where: { orderId: id, status: { not: "CANCELLED" } },
  select: { qty: true, deliveredQty: true },
});
const deliveredUnits =
  Math.round(activeLines.reduce((s, li) => s + Number(li.deliveredQty ?? 0), 0) * 1000) / 1000;
```

Return object gains `deliveredUnits` and `canCancel: blockers.length === 0 && deliveredUnits <= 0.001`.
In `assertCancellableOrThrow`, keep the payments throw for `blockingPayments.length > 0`
byte-identical; add after it:

```ts
throw new BadRequestException(
  `This order has delivered items (${impact.deliveredUnits} unit(s) already delivered). ` +
    `Cancelling would erase revenue for goods the customer already has. Record a return for ` +
    `the delivered goods, or edit the order down to the undelivered items instead.`,
);
```

2. **B64 — CANCELLED branch (~:2547) and `reopenOrder` (~:2718):** in the cancel
   tenantTransaction, FIRST read active items + credit stock, THEN the existing
   release/void loop unchanged, THEN flip items (order matters — invoice logic reads
   active items; the flip is what reopen keys on):

```ts
const activeItems = await tx.orderItem.findMany({
  where: { orderId: id, status: { not: "CANCELLED" } },
  select: { productId: true, qty: true, deliveredQty: true, status: true },
});
// B64 (REG-B64): return the creation-time decrement, clamped to the undelivered
// remainder (settleStockForEdit with an empty final set). Its DRAFT guard makes
// DRAFT→CANCELLED a no-op — drafts never decremented at create. `order` here is
// the PRE-cancel record (status not yet CANCELLED in memory).
await this.settleStockForEdit(tx, order, activeItems, []);
/* … existing releaseOrderCreditsInTx + per-invoice release/void loop, unchanged … */
// B64: mark what this cancel released. Pre-F07 cancels left items untouched and
// got no stock credit — reopenOrder re-decrements ONLY item-CANCELLED lines, so
// both eras stay conservation-consistent.
await tx.orderItem.updateMany({
  where: { orderId: id, status: { not: "CANCELLED" } },
  data: { status: "CANCELLED" },
});
```

   In `reopenOrder`'s tx, read the CANCELLED lines BEFORE the existing updateMany, and after
   it re-take the undelivered remainder (staff-only path → `user` undefined → warn-only
   oversell, matching create()):

```ts
const cancelledLines = await tx.orderItem.findMany({
  where: { orderId: id, status: ItemStatus.CANCELLED },
  select: { productId: true, qty: true, deliveredQty: true },
});
/* … existing updateMany CANCELLED→PENDING … */
if (cancelledLines.length > 0) {
  // Model the delivered portion as already-held so the settle delta is exactly
  // qty − deliveredQty per product (what the cancel credited back).
  await this.settleStockForEdit(
    tx,
    { id, status: OrderStatus.PENDING },
    cancelledLines.map((li) => ({
      productId: li.productId,
      qty: Number(li.deliveredQty ?? 0),
      deliveredQty: Number(li.deliveredQty ?? 0),
      status: "PENDING",
    })),
    cancelledLines.map((li) => ({ productId: li.productId, qty: Number(li.qty) })),
  );
}
```

3. **B65 — module + `deleteOrder` (~:5241):** `orders.module.ts` imports `RegulatedModule`
   (from `../regulated/regulated.module`); constructor gains
   `private readonly ledger: RegulatedLedgerService`. In the per-invoice teardown loop, FIRST
   line: `await this.ledger.reverseInvoiceEntries({ invoiceId: inv.id, db: tx });` with a
   comment naming the two sibling paths (voidInvoiceInTx, deleteInvoice) that already do this.
   No `preserveReturns` (mirror deleteInvoice). RegulatedModule imports
   Storage/Audit/Billing only — no cycle with OrdersModule (verified at discovery).

4. **B105 — DELIVERED branch else-path (~:2508):** replace the fire-and-forget with an awaited
   3-attempt loop retrying ONLY `ConflictException` (the number race regenerates internally);
   on final failure `logger.error` + throw:

```ts
throw new ConflictException(
  `The order was marked delivered, but its invoice could not be created ` +
    `(${lastErr?.message ?? "unknown error"}). Use "Create Invoice" on the order page to ` +
    `retry — the order stays delivered and nothing has been billed yet.`,
);
```

   The status update above is NOT reverted. Keep `capturedTenantId`. Non-Conflict errors break
   the loop immediately and surface through the same throw.

5. **B108 order side — the settle try/catch (~:2526):** wrap in a 3-attempt loop (backoff
   `await new Promise(r => setTimeout(r, attempt === 1 ? 100 : 300))` before attempts 2/3);
   final failure logs `logger.error` (replacing the warn); REWRITE the false comment to say the
   catch-up is now real because send()/sendEmail() settle order credits first (R13). Delivery
   still never fails on settle failure.

6. **B116 — create() tx (~:2043):** add options `{ timeout: 20000, maxWait: 5000 }` as the
   second arg of `tenantTransaction`. Replace the per-line decrement loop with the aggregated
   set-based UPDATE — EXACT code (aggregation is load-bearing: `UPDATE … FROM (VALUES …)`
   applies at most one row per join key):

```ts
const qtyByProduct = new Map<string, number>();
for (const li of stockLines) {
  qtyByProduct.set(li.productId, (qtyByProduct.get(li.productId) ?? 0) + li.qty);
}
await tx.$executeRaw`
  UPDATE "Product" AS p
  SET "currentStock" = p."currentStock" - v.qty
  FROM (VALUES ${Prisma.join(
    [...qtyByProduct.entries()].map(
      ([productId, qty]) => Prisma.sql`(${productId}::text, ${qty}::numeric)`,
    ),
  )}) AS v(id, qty)
  WHERE p.id = v.id
`;
```

   The FOR UPDATE lock, OOS per-line validation and staff warn-only oversell stay byte-identical.

### WP-API-INVOICES — invoices.service.ts (B108 send-side)

`satisfies: R12` · `provenBy: T17,T18` · Files: `apps/api/src/invoices/invoices.service.ts`.

In `send()` (~:3400) and `sendEmail()` (~:3595), IMMEDIATELY BEFORE the `explicitIds`
computation, add (comment per test-plan; settle honours explicit amounts and clamps — re-runs
are no-ops, money never moves twice; keep the exclusion for the sweep):

```ts
if (updated.orderId) {
  await this.creditNotes.settleOrderCreditsInTx(tx, updated.orderId);
}
```

Both call sites, identical shape. Nothing else in either method changes.

### WP-WEB — banner + cancel copy (B10 web, B56 web mirror)

`satisfies: R3(web half),R17(code half)` · `provenBy: T22 (post-deploy), T5 (shared shape)`
Files: `apps/web/app/(dashboard)/orders/[id]/page.tsx`, `apps/web/lib/cancel-impact.ts`,
`apps/web/lib/api/orders.ts`.

- Banner at ~:2291-2296: exact JSX in `ux-spec.md` §1 (condition `closedReason` truthy; copy
  by reason; comment rewritten to match API semantics, consistent with ~:1759).
- `lib/api/orders.ts` `CancelImpact` type (~:209): add `deliveredUnits: number;`.
- `lib/cancel-impact.ts`: `CancelImpactLike` gains `deliveredUnits: number`; the
  `!impact.canCancel` branch becomes reason-aware per `ux-spec.md` §2 (payments → byte-identical
  existing copy; else deliveredUnits>0 → delivered copy; else generic fallback). Keep the file
  header's mirror note.

### WP-MOBILE — cancel copy mirror (B56)

`satisfies: R3(mobile half)` · `provenBy: T5` · Files: `apps/mobile/lib/cancel-impact.ts`.
Byte-mirror WP-WEB's `cancel-impact.ts` change (same interface field, same branch, same
strings — the two files are declared mirrors in their headers; transcribe from `ux-spec.md`
§2, NOT from the web file, so the packages stay conflict-free).

### WP-E2E — spec 27 + config entry (B10 T2 deliverable — NOT a test package)

`satisfies: R17(proof half)` · `provenBy: T22 (runs only post-deploy)`
Files: `apps/web/e2e/27-cancelled-edit-banner.spec.ts` (new), `apps/web/playwright.config.ts`.

- Model the spec on `26-import-duplicates.spec.ts` (header discipline: what it proves, why no
  build-age self-skip, role, T2/proven-pending-deploy note) and `helpers/api.ts` for
  authenticated API calls. Flow per test-plan T22: API-create minimal order (seeded customer +
  product from the e2e tenant, qty 1), API-cancel, `page.goto('/orders/<id>')`, assert
  `getByText("Order cancelled — editing closed", { exact: true })` visible and
  `getByRole("button", { name: "Edit Items" })` hidden, `finally` API-delete the order. Test
  title MUST contain `REG-B10`. NO loose-name selectors, NO nth/index into lists, NO
  playwright execution (typecheck only).
- `playwright.config.ts`: add the `projects[]` entry (name `cancelled-edit-banner`, testMatch
  `/27-cancelled-edit-banner\.spec\.ts/`, `dependencies: ["setup"]`, operator storageState) with
  the spec-26-style comment "WITHOUT THIS ENTRY THE SPEC NEVER RUNS".

## Test packages (authored FIRST)

- **TP-API** — `apps/api/src/orders/orders.lifecycle-conservation.spec.ts` (new): T1-T4,
  T6-T16, T19, T20 per test-plan. Mock at module boundary (PrismaService with `forTenant()`
  + `tenantTransaction` capturing options and running the callback with a rich `tx` mock;
  InvoicesService, CreditNotesService, RegulatedLedgerService, CommissionEngine, gateway,
  notifications, authGuard as jest mocks — mirror the existing `orders.update-items-guards.spec.ts`
  harness shape). `as any` on every not-yet-existing field/arg so the RED run fails on
  assertions. Call-order oracles via a shared `calls: string[]` log pushed from each mock.
- **TP-INV** — `apps/api/src/invoices/invoices.send-settle.spec.ts` (new): T17, T18. Same
  harness discipline; mock creditNotes with both `settleOrderCreditsInTx` and
  `autoApplyOldestCreditsInTx` pushing to a call log.
- **TP-MOB** — extend `apps/mobile/__tests__/cancel-impact.test.ts` with the T5 `REG-B56`
  titles ONLY (existing tests untouched; new asserts on `(impact as any).deliveredUnits`
  input objects).

## Engine config decisions

- `redGate`: the two commands in test-plan (`expect: 'fail'`).
- `verifyCommands.perRound`: scoped jest (orders+invoices dirs exist at baseline → the
  baseline is honest, F06's broken-command lesson respected).
- `verifyCommands.final`: api `tsc -p tsconfig.build.json --noEmit`, api jest over
  orders+invoices+credit-notes, mobile full jest, web `check-types` (types the e2e spec +
  page edit). NO repo-wide `npm run verify` (its campaign-check step needs run artifacts a
  fresh worktree lacks — human close-out runs it).
- No `uiVerify` (browser proof is the post-deploy T2 run; local playwright is forbidden).
- `mutationProbe.targets`: the five in test-plan (all on HIGH-risk files).
- Implementation `dependsOn`: none — all five WPs are file-disjoint (WP-MOBILE transcribes
  from ux-spec, not from WP-WEB's output).

## Post-pipeline human close-out (NOT agent work)

Commit → full `npm run verify` in the worktree (regenerates `.campaign/runs/api.json`) →
`node scripts/campaign-check.mjs --batch F07` → ledger flips (T1 → `proven` with proof text;
B10 → `proven-pending-deploy`) → PR → coordinate merge with routeflow-6e after the docs train →
rebase (regen api.json, append Gate-3 lesson on top of #571's register) → merge → deploy watch →
`post-deploy-check` (`SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app`) →
deployment_status e2e discharges B10 (never dispatch) → D4 repair scripts (dry-run first;
JSONL to `local-assets/`): B56 voided-invoice report (identifiable: VOID invoices on CANCELLED
orders with delivered lines — REPORT ONLY for owner review; un-voiding is not mechanically safe)
and B64 stock restitution (CANCELLED orders with non-item-CANCELLED lines: credit
`qty − deliveredQty`, flip lines CANCELLED, per-row tx; promoted-draft ambiguity RECORDED as
unrepairable) → register chips + artifact republish (full Read LAST) → code map + `_meta.json` →
lessons entry → board #520 done.
