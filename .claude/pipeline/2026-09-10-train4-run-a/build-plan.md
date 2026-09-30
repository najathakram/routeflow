# Build plan: train 4 Run A — B134 B135 B214 (at-door approval tx boundary + invoice-delete credit orphaning)

> **Stage S5 ("how").** Written 2026-09-10. Status: `APPROVED` (for launch).
> **Model note:** bug-pipeline policy assigns S5 to Fable 5.1. Fable was out of usage credits on 2026-09-10 (a direct
> probe returned HTTP 429), so **Opus 5 wrote this plan as the documented fallback**. It transcribes the Fable cause ruling
> (`local-assets/handoff/2026-09-09/planning/train4/cause-ruling.md`) and designs no new behavior beyond it.
> Mode `bugfix`, scale `major`. The implementation and review agents receive only this file and
> [bug-test-plan.md](./bug-test-plan.md); both must stand alone.
> Grounding: every cited line was re-read at master `edd379bf` on 2026-09-10 and matched. Lines are approximate
> (±5); anchor on the quoted code, not the number.

---

## Objective

Three money/lifecycle defects, fixed in one run because they share two files.

- **B134.** `OrdersService.approveChangeRequestAtStop` un-sends linked SENT/VIEWED/OVERDUE invoices (flips them to DRAFT
  and nulls `sentAt`/`pdfUrl`) _before_ its merge transaction opens, through the non-transactional client. When the merge
  then fails (lost claim, stock guard, credit guard), the order is unchanged but the invoice stays un-sent.
- **B135.** The same function checks the at-door window (order status, run IN_PROGRESS, stop not COMPLETED/SKIPPED) and
  line delivery on a **pre-transaction snapshot**. A stop completed between that read and the row lock still gets an
  edit merged into it.
- **B214.** `InvoicesService.deleteInvoice` detaches credit notes the invoice sourced (`invoiceId → null`), and
  `OrdersService.deleteOrder` hard-deletes invoices, where the FK `ON DELETE SET NULL` does the same. Neither door
  checks the notes' balance, so both leave a fully spendable credit note with no provenance.

After the fix, a failed approval un-sends nothing. The window and the line state are judged on the locked row. Both
delete doors refuse with 409 `INVOICE_HAS_UNSPENT_CREDIT` while any sourced note is still open.

**In scope:** the three edits below (one new helper file, `invoices.service.ts`, `orders.service.ts`) plus the tests in
the test plan.

**Out of scope (the scope fence; each is a separate row if wanted):**

- B134's _post-delivery exemption_ half. It needs `resyncOrderInvoicesForEdit` ported into this function (ruling: "do
  NOT bolt on").
- The same pre-tx-revert shape in `updateOrderItems` (`orders.service.ts` ~3163, where its own tx opens ~3225). It is
  structurally identical but explicitly excluded by the ruling, so file it as a follow-up row. Also never thread a tx
  _into_ `updateOrderItems` (CLAUDE.md).
- `forceConsolidateCustomer`'s loser DRAFT-invoice delete (~1434). This is an unconfirmed third B214-shaped door; see
  the Sibling sweep section below.
- Refactoring `CreditNotesService.autoApplyOldestCreditsInTx`'s inline open filter onto the new helper. It is
  behavior-identical, but it is scope creep in a money file (L-008); file it as a follow-up.
- B215, B216, B131, B141 (train 4 Runs B+).
- Any data repair. See the Data repair section: read-only reports only, and none are written in this run.

## Constraints & conventions

- **Stack:** NestJS 11, Prisma 7, Postgres. `this.prisma.tenantTransaction(cb, opts)` is the interactive tx, and
  `tx: any` inside it. `tx.<model>.findUnique` is tenant post-filtered (`prisma.service.ts` ~167).
- **Tests:** Jest. Unit specs are `apps/api/src/**/*.spec.ts` using `createMockPrisma()`
  (`apps/api/src/testing/prisma-mock.ts`). DB-lane specs are `*.db.spec.ts`, collected only by
  `apps/api/jest.db.config.js`, and must use `describeDb` + `requireLocalDatabaseUrl` from
  `apps/api/src/common/testing/db-spec.ts` and `assertTestTenant` from `scripts/lib/test-tenants.cjs`. Test tenants are
  throwaway `qa-*` slugs only.
- **Lint/format:** ESLint per-workspace (`npm run lint -w apps/api`). Prettier: semicolons, double quotes, printWidth
  100, trailing commas.
- **Patterns to copy:**
  - the tx-scoped per-note loop in `InvoicesService.voidInvoiceInTx` (`invoices.service.ts` ~4120-4147)
  - the canonical open predicate documented at `credit-notes.service.ts` ~636-638 and implemented at ~665-675
  - the DB-lane wiring in `apps/api/src/invoices/invoice-numbering.db.spec.ts`
- **Must NOT change:**
  - the signature or body of `revertLinkedInvoicesForOrderEdit`, which already accepts `tx?`
  - `voidInvoiceInTx`'s void/cap behavior (pinned by wallet-integrity T9–T11)
  - `updateOrderItems`
  - the unlink of _closed_ notes in `deleteInvoice`
  - deleteOrder's ledger-reversal order (REG-B65)
  - any Prisma schema or migration (none needed: `0_init/migration.sql:3783` confirms
    `CreditNote_invoiceId_fkey … ON DELETE SET NULL`)
- **Do not introduce:** a new advisory lock or in-process lock (the existing `FOR UPDATE` suffices), a nested
  `$transaction`, Vitest, snapshot tests.
- **Landmines:**
  - The un-send must run **before the atomic claim** inside the tx, so a payments-throw aborts before any mutation
    (pin P4).
  - The in-tx re-read must use `select` with a `routeRunStop` key. The unit tests discriminate the pre-tx fetch
    (`include`) from the re-read by that key.
  - The heldItems select must gain `id: true`, or the in-tx line lookup can never match.
  - A scoped api jest run without `--reporters=default` overwrites `.campaign/runs/api.json` (L-063).

### Lessons carried into this plan

- **L-081** (F09, gate the money write inside the primitive, on the row it just read, as an exclude-list): the B214
  guard runs _inside_ each delete door's own transaction, on credit-note rows read through `tx`. "Open" is an
  exclude-list (only `VOID` is closed by status), so a fixture missing `status` still counts as open and is refused.
  Both doors are gated, not one: fixing only `deleteInvoice` is exactly the one-door fix L-081 warns about.
- **L-072** (one shared source, never hand-typed twins): the predicate lives in **one** exported helper
  (`sourced-credit-guard.ts`) imported by both doors. It is never re-inlined per door. Enum values come from
  `CreditNoteStatus`, never string literals.
- **L-060** (a "pin" must be green; a red pin is a live defect): P1–P7 are specified green-today and green-after. Any
  pin that comes out red escalates to a finding.
- **L-061** (exercise the composed chain): B214's orphaning is an FK + transaction effect, so T9/T10 drive the real
  `InvoicesService` over the real compose Postgres. A mocked tx cannot show a rollback.
- **L-063** (campaign reporter clobber): every scoped api jest command in this plan carries `--reporters=default`.
- **L-100** (a green pin never carries a `REG-` token; the red gate reads titles): pins have no REG token.
- **L-096** (grep for an existing primitive first): the helper reuses the canonical predicate already documented in
  `CreditNotesService`. The row lock reuses the existing `FOR UPDATE`. No new store and no new lock.

---

## Test packages (authored FIRST; tests only, no source edits)

### TP1 — Unit REG + pins in orders.service.spec.ts

- **writes:** `apps/api/src/orders/orders.service.spec.ts` (edit: additive tests only)
- **tests:** T1–T8 (REG), P1–P4 (pins)
- **brief:** Transcribe T1–T8 and P1–P4 exactly as specified in `bug-test-plan.md`, including the placements (new nested
  `describe("approveChangeRequestAtStop: tx boundary (B134/B135)")` inside `approveChangeRequestAtStop (P5-09)`, and T8
  plus P1–P3 inside the existing `describe("deleteOrder — delete-any")`), the `seenTx` capture, the
  `select.routeRunStop` discriminating mock, and the held row that carries `id` + `deliveredQty`. Keep one oracle per
  `it()`. The titles must begin with the exact REG tokens given. Pins carry no REG token. Do not modify or delete any
  existing test, except a harness remedy the test plan names.
- **must fail with (T1–T8):** the "Fails TODAY with" column. In short: T1/T3 give `received undefined` for the tx
  argument, T2 shows revert called before the lock, T4–T7 show `Received promise resolved instead of rejected`
  (`{ merged: true, … }`), and T8 resolves `{ success: true }`. P1–P4 pass.

### TP2 — DB-lane REG + pins (new file)

- **writes:** `apps/api/src/invoices/invoice-delete-credit.db.spec.ts` (**NEW**, created by this change)
- **tests:** T9, T10 (REG), P5–P7 (pins)
- **brief:** Build the file exactly per the test plan's "DB-lane file shape" section: wiring copied verbatim from
  `invoice-numbering.db.spec.ts`, `describeDb`, `requireLocalDatabaseUrl()` inside `beforeAll`, `qa-b214-*` tenants via
  `assertTestTenant`, one fresh tenant per test, and FK-ordered cleanup (creditNote → invoiceItem → invoice → customer →
  user → tenant). Drive the real `invoicesService.deleteInvoice(inv.id)` inside `tenantCtx.run(tenantId, …)`.
- **must fail with:** T9 resolves `{ id: "<inv.id>", message: "Invoice deleted successfully" }` instead of rejecting.
  T10: `expected "<inv.id>", received null`. P5–P7 pass.

**Red gate commands** (run only the REG tests; each must fail on an assertion, none may pass, no load errors):

```bash
cd apps/api && npx jest src/orders/orders.service.spec.ts -t "REG-B134|REG-B135|REG-B214" --reporters=default
node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- invoice-delete-credit -t REG-B214"
```

---

## Work packages

All three packages are HIGH-risk money files: `effort: high` each, model per engine default (Sonnet transcribes;
the exact code is below). The file lists are disjoint. WP2 and WP3 both depend only on WP1 and run in parallel in wave 2.

### WP1 — Shared sourced-credit guard (NEW file)

- **files:** `apps/api/src/credit-notes/sourced-credit-guard.ts` (**NEW**, created by this change)
- **provenBy:** T8, T9, T10 (pins P1–P3, P5–P7 freeze its closed cases)
- **dependsOn:** none
- **effort:** high
- **brief:** Create the file with exactly this content. It is a free-function module with no Nest provider, so both
  services import it directly, and the unit test of `deleteOrder` exercises the real predicate instead of a mock.

```ts
import { ConflictException } from "@nestjs/common";
import { CreditNoteStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";

/**
 * B214 (REG-B214): the ONE home of "a credit note sourced by an invoice still carries spendable
 * balance", for every door that destroys an invoice (InvoicesService.deleteInvoice and
 * OrdersService.deleteOrder's inline invoice loop). L-072: never re-inline this per door.
 *
 * Canonical open predicate (documented at CreditNotesService.autoApplyOldestCreditsInTx):
 *   status != VOID && (amount − amountUsed) > 0.001 && (expiresAt == null || expiresAt > now)
 * Exclude-list on status (L-081): only VOID is closed, so a row without `status` counts as open.
 *
 * Delete REFUSES where void (InvoicesService.voidInvoiceInTx) voids/caps: void keeps the audit
 * trail, delete does not (cause ruling 2026-09-09).
 */
export const OPEN_CREDIT_EPSILON = 0.001;

export function isOpenCreditNote(
  cn: {
    status?: string | null;
    amount?: unknown;
    amountUsed?: unknown;
    expiresAt?: Date | string | null;
  },
  now: Date = new Date(),
): boolean {
  if (cn.status === CreditNoteStatus.VOID) return false;
  if (cn.expiresAt != null && new Date(cn.expiresAt) <= now) return false;
  return roundMoney(Number(cn.amount ?? 0) - Number(cn.amountUsed ?? 0)) > OPEN_CREDIT_EPSILON;
}

/**
 * Throws 409 INVOICE_HAS_UNSPENT_CREDIT when any credit note sourced by one of `invoiceIds` is
 * still open. Call INSIDE the deleting transaction, BEFORE any write, with that tx.
 */
export async function assertNoUnspentSourcedCredits(tx: any, invoiceIds: string[]): Promise<void> {
  if (invoiceIds.length === 0) return;
  const now = new Date();
  const sourced = await tx.creditNote.findMany({
    where: { invoiceId: { in: invoiceIds }, status: { not: CreditNoteStatus.VOID } },
    select: {
      id: true,
      creditNoteNumber: true,
      invoiceId: true,
      amount: true,
      amountUsed: true,
      status: true,
      expiresAt: true,
    },
  });
  // Defense-in-depth scoping (mirrors voidInvoiceInTx / wallet-integrity T11): only notes these
  // invoices actually sourced can block the delete, whatever the query returned.
  const open = (sourced ?? []).filter(
    (cn: any) => invoiceIds.includes(cn.invoiceId) && isOpenCreditNote(cn, now),
  );
  if (open.length === 0) return;
  const remainingOf = (cn: any) => roundMoney(Number(cn.amount ?? 0) - Number(cn.amountUsed ?? 0));
  const unspent = roundMoney(open.reduce((s: number, cn: any) => s + remainingOf(cn), 0));
  throw new ConflictException({
    code: "INVOICE_HAS_UNSPENT_CREDIT",
    message:
      `This invoice issued credit ${open.map((cn: any) => cn.creditNoteNumber).join(", ")} ` +
      `with ${unspent.toFixed(2)} still unspent. Void the invoice instead — voiding retires the ` +
      `unspent credit and keeps the audit trail.`,
    creditNotes: open.map((cn: any) => ({
      id: cn.id,
      creditNoteNumber: cn.creditNoteNumber,
      remaining: remainingOf(cn),
    })),
  });
}
```

### WP2 — deleteInvoice refuses while a sourced note is open

- **files:** `apps/api/src/invoices/invoices.service.ts`
- **provenBy:** T9, T10 (pins P5–P7)
- **dependsOn:** WP1
- **effort:** high
- **brief:** Two edits in this file only.
  1. Add the import beside the other relative imports:
     `import { assertNoUnspentSourcedCredits } from "../credit-notes/sourced-credit-guard";`
  2. In `deleteInvoice` (~5323), insert the guard **immediately after** the recorded-payments `BadRequestException`
     block and **before** `adjustInvoicedQtyForInvoice` (so no write precedes it). Update the unlink comment only; the
     `updateMany` itself stays byte-identical.

```ts
if (inv.payments.length > 0) {
  throw new BadRequestException(
    "Cannot delete an invoice that has recorded payments. Remove all payments first, or void the invoice.",
  );
}

// B214 (REG-B214): refuse while a credit note this invoice sourced still has spendable
// balance — deleting would orphan it (invoiceId → null) as provenance-less wallet money.
// Runs before any write, on rows read through this tx (L-081).
await assertNoUnspentSourcedCredits(tx, [id]);

// … adjustInvoicedQtyForInvoice / reverseInvoiceEntries unchanged …

// Unlink the remaining (closed: spent, VOID or expired) credit notes this invoice sourced;
// open ones were refused above.
await tx.creditNote.updateMany({
  where: { invoiceId: id },
  data: { invoiceId: null },
});
```

### WP3 — approveChangeRequestAtStop tx boundary (B134/B135) + deleteOrder refuses (B214)

- **files:** `apps/api/src/orders/orders.service.ts`
- **provenBy:** T1–T8 (pins P1–P4)
- **dependsOn:** WP1
- **effort:** high
- **brief:** Four edits in this file only.

**Edit 0 (import).** Add beside the other relative imports:
`import { assertNoUnspentSourcedCredits } from "../credit-notes/sourced-credit-guard";`

**Edit 1 (B134: remove the pre-tx un-send).** In `approveChangeRequestAtStop` (~4843), delete this block (~4915-4918)
and nothing else around it. The pre-tx guards at ~4864-4876 **stay** as the cheap fast path.

```ts
// Auto-revert a SENT pending-mirror invoice to DRAFT so the merge re-syncs
// into it; throws if it carries payments (money never detaches). Mirrors
// updateOrderItems :1630-1634.
await this.invoicesService.revertLinkedInvoicesForOrderEdit(order.id);
```

**Edit 2 (B135 re-check + B134 in-tx un-send + heldItems id).** Inside the `tenantTransaction` callback, replace the
current lock + heldItems lines (~4944-4948):

```ts
await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
const heldItems = await tx.orderItem.findMany({
  where: { orderId: order.id },
  select: { productId: true, qty: true, deliveredQty: true, status: true },
});
```

with exactly:

```ts
await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

// B135 (REG-B135): the window guards above ran on a pre-tx snapshot. Re-assert them on
// the row we now hold locked — a stop completed (completeWithPayment) between that read
// and this lock must refuse, never merge into a delivered order. `select` (not include)
// with routeRunStop: the unit tests key the in-tx re-read on that shape.
const live = await tx.order.findUnique({
  where: { id: order.id },
  select: {
    tenantId: true,
    status: true,
    routeRun: { select: { status: true } },
    routeRunStop: { select: { status: true } },
  },
});
if (!live) throw new NotFoundException("Order not found");
if (!["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(live.status)) {
  throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "ORDER_STATUS" });
}
if (live.routeRun == null || live.routeRun.status !== "IN_PROGRESS") {
  throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "RUN_NOT_ACTIVE" });
}
if (live.routeRunStop != null && ["COMPLETED", "SKIPPED"].includes(live.routeRunStop.status)) {
  throw new ConflictException({ code: "STOP_ALREADY_COMPLETED" });
}

// B134 (REG-B134): auto-revert a SENT pending-mirror invoice to DRAFT INSIDE the merge tx
// (plain queries, no nested tx), so any later throw here — lost claim, stock, credit —
// rolls the un-send back with the merge. Before the claim: a payments-throw aborts
// before any mutation. Throws if it carries payments (money never detaches).
await this.invoicesService.revertLinkedInvoicesForOrderEdit(order.id, tx);

const heldItems = await tx.orderItem.findMany({
  where: { orderId: order.id },
  select: { id: true, productId: true, qty: true, deliveredQty: true, status: true },
});
```

The existing WP1/F2 comment directly above the `FOR UPDATE` line stays. The atomic claim that follows is unchanged.

**Edit 3 (B135 line guard off the locked row).** In the `CHANGE_QTY || REMOVE_ITEM` branch (~4974-4982), replace:

```ts
const li = order.lineItems.find((l) => l.id === targetId);
if (!li || li.status === "CANCELLED") {
  throw new BadRequestException("Order line not found or already cancelled");
}
if (Number(li.deliveredQty) > 0) {
  throw new ConflictException({ code: "LINE_ALREADY_DELIVERED" });
}
```

with:

```ts
const li = order.lineItems.find((l) => l.id === targetId);
// B135 (REG-B135): judge cancel/delivery on the LOCKED in-tx row, not the pre-tx
// snapshot; the snapshot is the fallback only when the held read has no such row.
const held = heldItems.find((h: any) => h.id === targetId);
if (!li || li.status === "CANCELLED" || held?.status === "CANCELLED") {
  throw new BadRequestException("Order line not found or already cancelled");
}
if (Number((held ?? li).deliveredQty ?? 0) > 0) {
  throw new ConflictException({ code: "LINE_ALREADY_DELIVERED" });
}
```

Everything after it (`li.id` updates, stock delta from `heldItems`, totals, credit guard, `DeliveryMutation`, post-commit
reconcile/revision) is unchanged.

**Edit 4 (B214, deleteOrder door).** In `deleteOrder` (~5522), make the guard the **first statement** inside the
`tenantTransaction` callback, before `releaseOrderCreditsInTx`:

```ts
    await this.prisma.tenantTransaction(async (tx) => {
      // B214 (REG-B214): this loop hard-deletes invoices WITHOUT going through
      // InvoicesService.deleteInvoice (ledger-reversal duplication, see below), so it must refuse
      // on its own — same shared guard, before any write (L-072, L-081).
      await assertNoUnspentSourcedCredits(
        tx,
        order.invoices.map((inv) => inv.id),
      );
      await this.creditNotes.releaseOrderCreditsInTx(tx, id);
      // … rest unchanged …
```

Callers were verified on 2026-09-10 and none break on the new 409:

- `bulkDeleteOrders` (~5638) uses `Promise.allSettled` and reports `"<id>: <message>"` in `errors`.
- `change-requests.service.ts` ~387 is a `.catch(() => {})` compensation delete of a fresh draft that has no invoices.

### Package map

| Pkg | Files                                      | provenBy       | dependsOn | Wave  |
| --- | ------------------------------------------ | -------------- | --------- | ----- |
| TP1 | orders.service.spec.ts                     | T1–T8, P1–P4   | —         | tests |
| TP2 | invoice-delete-credit.db.spec.ts (new)     | T9, T10, P5–P7 | —         | tests |
| WP1 | credit-notes/sourced-credit-guard.ts (new) | T8, T9, T10    | —         | 1     |
| WP2 | invoices/invoices.service.ts               | T9, T10        | WP1       | 2     |
| WP3 | orders/orders.service.ts                   | T1–T8          | WP1       | 2     |

Cross-check: every T# (T1–T10) and every pin (P1–P7) appears in some package's `provenBy`.

---

## Acceptance criteria

1. **B134:** `approveChangeRequestAtStop` makes no call to `revertLinkedInvoicesForOrderEdit` outside the merge
   `tenantTransaction`. The only call passes that tx and runs after the `FOR UPDATE` lock and before the atomic claim.
   Proven by T1, T2, T3 and P4.
2. **B134:** a failed approval (lost claim, stock guard, credit guard) leaves every linked invoice's
   status/`sentAt`/`pdfUrl` exactly as before, because the un-send rolls back with the tx. Proven by T3 in the unit lane.
3. **B135:** after the lock, the order status, run status and stop status are re-read through `tx` and re-asserted with
   the **same** error codes as the pre-tx guards: `CHANGE_WINDOW_CLOSED`/`ORDER_STATUS`,
   `CHANGE_WINDOW_CLOSED`/`RUN_NOT_ACTIVE`, `STOP_ALREADY_COMPLETED`. Proven by T4–T6.
4. **B135:** `LINE_ALREADY_DELIVERED` and the cancelled-line refusal read the in-tx held row, with the snapshot used only
   as a fallback. Proven by T7.
5. **B214:** `deleteInvoice` and `deleteOrder` both refuse with 409 `{ code: "INVOICE_HAS_UNSPENT_CREDIT", message,
creditNotes[] }` while any credit note sourced by an invoice being deleted is open. "Open" means non-VOID, unexpired,
   and remaining > 0.001. After a refusal no row changes, and the note keeps its `invoiceId`. Proven by T8, T9, T10.
6. **B214:** the predicate exists in exactly one place, `sourced-credit-guard.ts`. Both doors import it, and neither
   inlines an `amount - amountUsed` check of its own (L-072).
7. **Negative cases:** spent, VOID or expired sourced notes do **not** block either delete, and `deleteInvoice` still
   unlinks them. The void door's behavior (wallet-integrity T9–T11) is unchanged. Proven by P1–P3 and P5–P7.
8. **Deploy day:** no schema change, no migration, no flag. Existing orders and invoices behave as before, except that
   the two delete doors now refuse the open-credit case and a stale at-door approval now 409s instead of merging.

---

## Verification commands (all exist; all scoped to apps/api)

Per round:

```bash
npm run check-types -w apps/api
npm run lint -w apps/api
```

Final (once):

```bash
cd apps/api && npx jest src/orders/ src/invoices/invoices src/credit-notes/credit-notes.wallet-integrity src/customers/customers.purge-ledger --reporters=default
npm run local:test:db
```

`npm run local:test:db` = `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`. It runs every
`*.db.spec.ts`, the new one included, against the compose Postgres (localhost:5432, already up on this machine) with
`RUN_DB_SPECS=local`. Its reporter is `default`, so it never clobbers campaign reports. The full api suite and
`campaign-check` belong to the pre-push `npm run verify`, not to this run. Never run a repo-wide suite from the engine.

## Mutation probes (fix-revert)

| Target                                              | Kind                                                                                         | Must go red                                                                                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/orders/orders.service.ts`             | `revertFix: true` (restore HEAD by copy)                                                     | `REG-B134 (T1)`; T2–T8 also go red                                                                                                                                  |
| `apps/api/src/invoices/invoices.service.ts`         | `revertFix: true`                                                                            | `REG-B214 (T9)`, a **DB-lane** test: run it with `node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api -- invoice-delete-credit -t REG-B214"` |
| `apps/api/src/credit-notes/sourced-credit-guard.ts` | mutation (the file is new, so HEAD has none; a revert would be a load error, not a behavior) | `REG-B214 (T8)`: e.g. flip `> OPEN_CREDIT_EPSILON` or drop the VOID/expiry exclusion; T8 or P1–P3 must catch it                                                     |

## Sibling sweep (notes for the Opus judge)

- `tx\.invoice\.delete\(|invoice\.delete\(\{` has three hits. `invoices.service.ts` ~5363 (deleteInvoice) and
  `orders.service.ts` ~5593 (deleteOrder) are both fixed here. `orders.service.ts` ~1434 (`forceConsolidateCustomer`,
  which deletes a merge loser's pending-mirror DRAFT invoice) is **unconfirmed**: nothing there reads a credit note,
  and a never-sent draft is not an observed note source. If the judge rules it a defect, the **only** acceptable fix is
  `await assertNoUnspentSourcedCredits(tx, [<loser invoice id>])` before that delete. Otherwise record it as a
  follow-up row. Do not restructure the consolidation.
- `data: \{ invoiceId: null \}`: only `deleteInvoice` is expected. Any other hit is a candidate B214 door, judged the
  same way.
- `order\.lineItems\.find\(`: the B135 site at ~4976 is fixed. The hits at ~3932, ~3969 and ~4051 sit inside
  `updateOrderItems`, which takes its own `FOR UPDATE` (~3235). They are unconfirmed, and never an in-run fix: the
  judge records a verdict and the owner files a row.
- **Known and excluded (not a sweep defect):** `updateOrderItems`' pre-tx `revertLinkedInvoicesForOrderEdit` (~3163) is
  deferred by the ruling. Do not fix it in this run.

## Data repair (S3.6): reports only, no backfill in this run

| Bug  | Prod rows possibly corrupted?                                                                                                                                                                                                                                                                                       | Read-only report that would measure it (NOT written in this run)                                                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B134 | **Plausibly yes.** Every at-door approval that failed after the un-send (lost claim, stock, credit) left a formerly SENT/VIEWED/OVERDUE invoice in DRAFT with `sentAt`/`pdfUrl` null and the audit line `reverted to Draft: source order edited` in `internalNotes`, which the customer-facing state never re-sends | proposed `apps/api/scripts/report-b134-unsent-invoices.mjs`: DRAFT invoices whose `internalNotes` carry that audit line, joined to their order's ChangeRequests. It flags those with no APPROVED `MERGED_AT_STOP` resolution at or after the stamp. Successful approvals also revert by design until the deferred exemption row lands, so the report must separate the two |
| B135 | **Plausibly yes, rare.** An at-door edit merged after the stop completed (or after the line was delivered) changed a delivered order's lines and totals                                                                                                                                                             | proposed `apps/api/scripts/report-b135-late-door-merges.mjs`: `DeliveryMutation` rows from at-door merges created after the order's `RouteRunStop` completion. Confirm the timestamp columns when writing it                                                                                                                                                               |
| B214 | **Plausibly yes.** Every past `deleteInvoice`/`deleteOrder` of an invoice with a sourced note left the note with `invoiceId = NULL` and its balance spendable                                                                                                                                                       | proposed `apps/api/scripts/report-b214-orphan-credit-notes.mjs`: `CreditNote` rows with `invoiceId IS NULL`, `status != 'VOID'` and `amount - "amountUsed" > 0.001`, per tenant. Legitimately invoice-less notes exist, so cross-check against audit rows or the note's `reason`/items before any owner decision                                                           |

The owner decides any repair after reading a report, with a fresh backup, via a dry-run-first script, and never on a
live client tenant without an explicit request.

## Risks & rollback

| Risk                                                                                                                      | Likelihood | Blast radius                               | Mitigation / reviewer watch                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revert + re-read add ~5 queries inside the 15 s interactive tx that holds the Order row lock                              | low        | at-door approval latency                   | Plain indexed queries. Watch for timeouts in `local:test:db` and logs                                                                                                                           |
| An existing approve test used `mockResolvedValueOnce` for `order.findUnique`, so the in-tx re-read gets `null` → NotFound | low        | test-only                                  | Harness note in the test plan; the remedy is `mockResolvedValue`                                                                                                                                |
| The new 409 surfaces in web/mobile delete flows as a raw error                                                            | med        | UX only (money safe)                       | The body carries `message`. Whether the web delete dialogs show the server message was **not verified** here, so the reviewer should check the web invoice/order delete handlers read `message` |
| The sweep judge "fixes" `updateOrderItems` ~3163                                                                          | low        | scope/regression in the hottest money path | Excluded explicitly above. A fixer touching `updateOrderItems` is out of scope                                                                                                                  |
| Probe on invoices.service.ts runs the unit jest instead of the DB lane                                                    | med        | the probe is reported skipped or invalid   | The probe table names the exact DB-lane command                                                                                                                                                 |

- **Rollback:** revert the squash commit. There is no schema change, no flag and no data write.
- **Migration reversibility:** none needed (no migration).
- **Feature flag / entitlement:** none.
- **Deploy day:** existing rows are untouched. Delete attempts on invoices or orders whose invoices sourced open credit
  now 409, and the operator voids the invoice instead. Stale at-door approvals now 409.
- **Observability:** look for 409 `INVOICE_HAS_UNSPENT_CREDIT` on `DELETE /invoices/:id` and `DELETE /orders/:id`, and
  for 409 `STOP_ALREADY_COMPLETED`/`CHANGE_WINDOW_CLOSED` from change-request resolve at the door.

## Close-out reminders (for the coordinator)

- The branch is `fix/*`. The code PR's HEAD commit carries `Bookkeeping-Follow-Up: pending` (Gate 2/3). The docs-only
  follow-up after merge updates the code map (`api.md` entries for `orders.service.ts`, `invoices.service.ts`, and the
  new `credit-notes/sourced-credit-guard.ts`) and appends ONE lesson. Check the register's cap first: it has been at
  40/40, so archive one entry before adding.
- Registry proof: B134 → T1/T3, B135 → T4/T7, B214 → T8 (the unit title `campaign-check` can see). T9/T10 are
  supporting evidence.
- File follow-up rows: the B134 post-delivery exemption, the `updateOrderItems` ~3163 pre-tx revert, and the
  autoApply predicate consolidation onto `isOpenCreditNote`.

---

## Pipeline args

Launcher: copy this file, `bug-test-plan.md` and `pipeline-args.json` into `.claude/pipeline/2026-09-10-train4-run-a/`
on the run branch, fix the date in `planPath`/`testPlanPath`, and add `startedAt` + `workdir`. Pass the args as a real
OBJECT, never a JSON string. The object below is identical to `pipeline-args.json` (under 4 KB minified).

```json
{
  "mode": "bugfix",
  "planPath": ".claude/pipeline/2026-09-10-train4-run-a/build-plan.md",
  "testPlanPath": ".claude/pipeline/2026-09-10-train4-run-a/bug-test-plan.md",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "scale": "major",
  "context": "Train 4 Run A: B134/B135 move approveChangeRequestAtStop's invoice un-send and window re-checks inside the merge tx; B214 deleteInvoice+deleteOrder refuse (409) while a sourced credit note has unspent balance. S4/S5 by Opus 5 (Fable 429).",
  "radiusFiles": [
    "apps/api/src/orders/orders.service.ts",
    "apps/api/src/invoices/invoices.service.ts",
    "apps/api/src/credit-notes/sourced-credit-guard.ts",
    "apps/api/src/credit-notes/credit-notes.service.ts",
    "apps/api/prisma/schema/finance.prisma",
    "apps/api/src/orders/orders.service.spec.ts",
    "apps/api/src/invoices/invoice-delete-credit.db.spec.ts",
    "apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts",
    "apps/api/src/orders/orders-promo-bogo.spec.ts"
  ],
  "siblingPatterns": [
    {
      "regex": "tx\\.invoice\\.delete\\(|invoice\\.delete\\(\\{",
      "note": "B214 doors; see build-plan Sibling sweep (forceConsolidateCustomer ~1434 unconfirmed)"
    },
    {
      "regex": "data: \\{ invoiceId: null \\}",
      "note": "credit-note unlink; only deleteInvoice expected"
    },
    {
      "regex": "order\\.lineItems\\.find\\(",
      "note": "B135 stale-snapshot shape; see build-plan Sibling sweep"
    }
  ],
  "testPackages": [
    {
      "id": "TP1",
      "title": "Unit REG + pins",
      "files": ["apps/api/src/orders/orders.service.spec.ts"],
      "brief": "build-plan.md TP1 (T1-T8, P1-P4)"
    },
    {
      "id": "TP2",
      "title": "DB-lane REG + pins",
      "files": ["apps/api/src/invoices/invoice-delete-credit.db.spec.ts"],
      "brief": "build-plan.md TP2 (T9-T10, P5-P7)"
    }
  ],
  "redGate": {
    "commands": [
      "cd apps/api && npx jest src/orders/orders.service.spec.ts -t \"REG-B134|REG-B135|REG-B214\" --reporters=default",
      "node scripts/local-env.mjs --db --db-specs -- \"npm run test:db -w apps/api -- invoice-delete-credit -t REG-B214\""
    ],
    "expect": "fail"
  },
  "packages": [
    {
      "id": "WP1",
      "title": "Shared sourced-credit guard",
      "files": ["apps/api/src/credit-notes/sourced-credit-guard.ts"],
      "brief": "build-plan.md WP1 exact code",
      "effort": "high",
      "provenBy": ["T8", "T9", "T10"]
    },
    {
      "id": "WP2",
      "title": "deleteInvoice refuses",
      "files": ["apps/api/src/invoices/invoices.service.ts"],
      "brief": "build-plan.md WP2 exact code",
      "dependsOn": ["WP1"],
      "effort": "high",
      "provenBy": ["T9", "T10"]
    },
    {
      "id": "WP3",
      "title": "Approve-at-stop tx boundary + deleteOrder refuses",
      "files": ["apps/api/src/orders/orders.service.ts"],
      "brief": "build-plan.md WP3 exact code (Edits 0-4)",
      "dependsOn": ["WP1"],
      "effort": "high",
      "provenBy": ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"]
    }
  ],
  "verifyCommands": {
    "perRound": ["npm run check-types -w apps/api", "npm run lint -w apps/api"],
    "final": [
      "cd apps/api && npx jest src/orders/ src/invoices/invoices src/credit-notes/credit-notes.wallet-integrity src/customers/customers.purge-ledger --reporters=default",
      "node scripts/local-env.mjs --db --db-specs -- \"npm run test:db -w apps/api -- invoice-delete-credit\""
    ]
  },
  "mutationProbe": {
    "targets": [
      {
        "file": "apps/api/src/orders/orders.service.ts",
        "revertFix": true,
        "behavior": "un-send + window re-checks run inside the merge tx",
        "test": "REG-B134 (T1)"
      },
      {
        "file": "apps/api/src/invoices/invoices.service.ts",
        "revertFix": true,
        "behavior": "deleteInvoice refuses on an unspent sourced note",
        "test": "REG-B214 (T9)"
      },
      {
        "file": "apps/api/src/credit-notes/sourced-credit-guard.ts",
        "behavior": "open = non-VOID, unexpired, remaining > 0.001",
        "test": "REG-B214 (T8)"
      }
    ]
  }
}
```

> Amended at resume 2026-09-10: final DB gate scoped to invoice-delete-credit (whole-lane local:test:db fails at Baseline on the unrelated cron-lock.db.spec.ts and would be excluded from the verdict).
