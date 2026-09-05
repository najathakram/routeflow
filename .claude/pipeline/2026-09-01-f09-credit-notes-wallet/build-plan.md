# F09 · Build plan

**Status: IN PROGRESS** · Base master@3d1d8ea9, worktree `.claude/worktrees/rf-F09`, branch
`fix/F09-credit-notes-wallet`. ONE PR, handed to routeflow-9a for the serial merge — do not
merge. Artifacts: `discovery.md`, `spec.md`, `test-plan.md` (this dir). Code map:
`.claude/code-map/INDEX.md` → `api.md` / `web.md` / `mobile.md`.

## The one idea

`settleOrderCreditsInTx` is a **primitive with six callers**, two added by F07 (#588). Every fix
here goes at a primitive, never at a call site: a per-caller guard would need six patches today
and miss the seventh tomorrow.

## Exact code for the tricky parts

**1. The shared status sets — `apps/api/src/invoices/invoice-status-sets.ts` (NEW).** The three
sets differ *on purpose*; the comments are the deliverable, not decoration.

```ts
import { InvoiceStatus } from "@prisma/client";

/** Manual operator apply (`applyToInvoice`): refuses a settled, dead or forgiven target. */
export const CREDIT_NOT_APPLICABLE: InvoiceStatus[] = [
  InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF,
];

/**
 * Automatic settle (`settleOrderCreditsInTx`). Deliberately NARROWER than
 * CREDIT_NOT_APPLICABLE: settle runs a SHRINK pass (un-applying now-excess credit) over the
 * same invoice list before it applies anything, and PAID invoices are exactly where shrink has
 * work to do. Excluding PAID would strand customer money on a PAID invoice whose total was
 * later edited down. Keeping PAID in the APPLY pass is harmless — applyCreditInTx clamps to the
 * remaining balance, which is zero. Do NOT "simplify" this into CREDIT_NOT_APPLICABLE.
 */
export const CREDIT_SETTLE_EXCLUDED: InvoiceStatus[] = [
  InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF,
];

/** Delivery payment targets (`recordDeliveryPaymentInTx`): an ALLOW-list, not an exclude-list. */
export const PAYABLE: InvoiceStatus[] = [
  InvoiceStatus.DRAFT, InvoiceStatus.SENT, InvoiceStatus.PARTIAL, InvoiceStatus.OVERDUE,
];
```

**2. B67 — the settle filter** (`credit-notes.service.ts`, `settleOrderCreditsInTx` ~:930):

```ts
const invoices = await tx.invoice.findMany({
  where: { orderId, status: { notIn: CREDIT_SETTLE_EXCLUDED } },   // was: { not: "VOID" }
  include: { payments: true },
  orderBy: { invoiceNumber: "asc" },
});
```

**3. B66 — `create()` must read status** (`credit-notes.service.ts` ~:108). Add `status: true`
to the existing `select`, then immediately after the customer check:

```ts
if (invoice.status === InvoiceStatus.VOID || invoice.status === InvoiceStatus.DRAFT) {
  throw new BadRequestException(
    `Cannot issue a credit note against a ${invoice.status} invoice.`,
  );
}
```

**4. B66 — void caps the credit it sourced** (`invoices.service.ts`, inside `voidInvoiceInTx`,
BEFORE the status flip returns). Cap, never claw back:

```ts
// F09/B66: a credit note's headroom dies with the invoice that justified it. Remove only the
// UNUSED portion — already-spent credit paid real invoices and clawing it back would corrupt
// them. Fully-unused ⇒ VOID; partly-used ⇒ capped to what was spent.
const sourced = await tx.creditNote.findMany({
  where: { invoiceId: id, status: { not: "VOID" } },
  select: { id: true, amount: true, amountUsed: true },
});
for (const cn of sourced) {
  const used = Number(cn.amountUsed ?? 0);
  await tx.creditNote.update({
    where: { id: cn.id },
    data: used <= 0.001 ? { status: "VOID" } : { amount: roundMoney(used) },
  });
}
```

**5. B19 — `findAll` include** (`credit-notes.service.ts` ~:280): add
`invoice: { select: { id: true, invoiceNumber: true } }`, matching `findOne`'s existing shape.

## Work packages

| id | title | files | dependsOn | satisfies | provenBy |
| --- | --- | --- | --- | --- | --- |
| `TP-API` | Author the two jest specs (gate file + pins). Implementation forbidden. | `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts`, `…pins.spec.ts` | — | — | T1–T12 |
| `P1` | Shared status sets + re-point the two existing call sites, **behaviour-neutral** | `apps/api/src/invoices/invoice-status-sets.ts` (new), `apps/api/src/invoices/invoices.service.ts`, `apps/api/src/credit-notes/credit-notes.service.ts` | — | R3a | T1–T5 |
| `P2` | B67 settle filter · B66 `create()` status guard · B19 `findAll` include | `apps/api/src/credit-notes/credit-notes.service.ts` | P1 | R1,R2,R3,R4,R9 | T1–T8,T12 |
| `P3` | B66 void-side credit capping | `apps/api/src/invoices/invoices.service.ts` | P2 | R5,R6 | T9,T10,T11 |
| `P4` | B18 API: delete no-op `issue()` + its `@Post(":id/issue")` route | `apps/api/src/credit-notes/credit-notes.service.ts`, `…controller.ts` | P3 | R7 | T14 |
| `P5` | Web: B18 UI removal · B19 three render sites · B13 Apply-advance action + delete duplicate hook | `apps/web/app/(dashboard)/credit-notes/page.tsx`, `…/[id]/page.tsx`, `apps/web/app/(dashboard)/invoices/[id]/page.tsx`, `apps/web/lib/api/credit-notes.ts`, `apps/web/lib/api/customers.ts` | — | R7,R10,R11,R12 | T13,T14,T15 |
| `P6` | Mobile: B18 removal (hook usage, Draft filter chip, DRAFT case) | `apps/mobile/app/(operator)/credit-notes/[id].tsx`, `…/index.tsx`, `…/new.tsx`, `apps/mobile/lib/api/credit-notes.ts` | — | R7 | (build) |
| `P7` | e2e **spec 28** + `playwright.config.ts` `projects[]` entry | `apps/web/e2e/28-credit-note-wallet.spec.ts`, `apps/web/playwright.config.ts` | P5 | R7,R10,R11 | T13,T14,T15 |

`P1→P2→P3→P4` serialise on genuine file overlap. `P5`/`P6` are disjoint and run alongside.
`P7` follows `P5` because it asserts that UI.

## Red gate

```
cd apps/api && npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts
```
`expect: fail` — every test must fail on an assertion. Spec 28 is **not** in the gate (deployed
build only). The pins file is out of gate scope by design.

## verifyCommands (scoped — a repo-wide gate would fail at baseline on a fresh worktree)

- perRound: `cd apps/api && npx jest src/credit-notes src/invoices`
- final: `cd apps/api && npx jest src/credit-notes src/invoices && npx tsc -p tsconfig.build.json --noEmit`

`npm run verify` is deliberately NOT used: its last step reads run artifacts that only exist
after a full local pass, so it is excluded at baseline and the run would silently lose its gate.
Whole-repo verification is the human close-out.

## Close-out

Ledger flips with evidence (B66/B67 → `proven`; B13/B18/B19 → `proven-pending-deploy`) ·
`campaign-check --batch F09` · D4 flight **per-window** with a positive control, dry-run to the
owner, never `--execute` · code-map surgical + `_meta` bump · lessons entry with the id
re-derived as max(all ids)+1 from the REBASED tree, `activeCount` by counting · register: local
HTML only, write lock via 9a, report published copy STALE · hand the PR to routeflow-9a.
