import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus, type Prisma } from "@prisma/client";
import { lockCreditsForSend } from "../credit-notes/credit-note-locks";
import type { CreditNotesService } from "../credit-notes/credit-notes.service";
import { retryCreditTx } from "../common/tx-retry";
import type { PrismaService } from "../prisma/prisma.service";
import { lockInvoiceRow, sendRefusal } from "./invoice-send-guard";
import { BILL_TO_ADDRESS_ORDER } from "./invoice-bill-to";
import { invoiceFingerprint } from "./invoice-send-state";
import { resolveInvoiceVariant } from "./invoice-stage";

/**
 * SA-860 (W-702): the ONE read an issuing/re-sent invoice email is built from. The PDF, the email payload and the send
 * fingerprint are all rendered from this object, so the document the customer gets, the figure the operator sees and the
 * hash the record stores can never come from three different reads.
 *
 * It is the PDF service's include (customer + every bill-to address, items with product codes / levy category /
 * components, every non-VOID payment with its credit note, the order) with the customer's email added (the recipient
 * check) and the payment listing ordered `paidAt` then `id` (the order `FINGERPRINT_INCLUDE` hashes in, so the snapshot's
 * fingerprint equals the live one for the same rows).
 */
export const SEND_SNAPSHOT_INCLUDE = {
  customer: {
    select: {
      id: true,
      businessName: true,
      contactName: true,
      email: true,
      phone: true,
      addresses: { orderBy: BILL_TO_ADDRESS_ORDER }, // #2088: the fingerprint reads the same first row
    },
  },
  items: {
    include: {
      product: { select: { id: true, name: true, barcode: true, sku: true, unitSku: true } },
      // CQ-03: the category row names the levy charge ("CRV deposit")
      trackedCategory: { select: { id: true, name: true, taxType: true } },
      // #2717 M3: the frozen sub-lines of a composed (FIXED) line; empty on a plain line.
      components: { orderBy: { position: "asc" } },
    },
  },
  // F03/R1/B97 fix: this is a LISTING read (the Payment History section), so it keeps the broad not:VOID filter: a DRAFT
  // (unconfirmed) row stays VISIBLE on the document under a "Pending confirmation" label. The MONEY (Amount Paid /
  // Balance Due) is computed from `sumConfirmed` / `splitConfirmed` over this listing, never from the where-clause.
  // scan-ok: draft-payment-not-void - intentional LISTING filter (R2); the money narrows via sumConfirmed, never this where-clause.
  payments: {
    where: { status: { not: "VOID" } },
    orderBy: [{ paidAt: "asc" }, { id: "asc" }],
    include: { creditNote: { select: { creditNoteNumber: true, reason: true } } },
  },
  order: { select: { status: true, fulfillPath: true, shippedAt: true, counterSale: true } },
} satisfies Prisma.InvoiceInclude;

export type SendSnapshot = Prisma.InvoiceGetPayload<{ include: typeof SEND_SNAPSHOT_INCLUDE }>;

/**
 * Thrown on purpose at the end of the issuing dry run: it carries the snapshot out of a `tenantTransaction` whose only
 * job was to read it AFTER the real send-time credits ran, and rolls everything back (SA-860 ruling 2). Nothing the dry
 * run wrote ever commits.
 */
export class SendSnapshotRollback extends Error {
  constructor(
    readonly snapshot: SendSnapshot,
    readonly issuing: boolean,
  ) {
    super("send snapshot dry run (rolled back on purpose)");
    this.name = "SendSnapshotRollback";
  }
}

/** What the snapshot shows to the customer, as the record stores it: the resolved stage and the fingerprint of that stage. */
export async function fingerprintOfSnapshot(
  featureConfig: any,
  tenantId: string | null | undefined,
  snapshot: SendSnapshot,
  variant?: string,
): Promise<{ stage: string; fingerprint: string }> {
  const stage =
    variant ?? (await resolveInvoiceVariant(featureConfig, tenantId, snapshot, snapshot.order));
  return { stage, fingerprint: invoiceFingerprint({ ...snapshot, variant: stage }) };
}

/**
 * The send-time money, ONE copy (SA-860): markSent's real commit and the issuing dry run both call this with the same
 * arguments, so the preview can never drift from what is applied. Only the DRAFT -> SENT issue (`issuing`, SA-857)
 * settles order credits and runs the oldest-first sweep; a re-send moves no money.
 */
export async function runSendCredits(
  creditNotes: CreditNotesService,
  tx: any,
  id: string,
  issuing: boolean,
  row: { orderId: string | null; customerId: string },
): Promise<{ applied: number; invoiceStatus: InvoiceStatus | null }> {
  if (!issuing) return { applied: 0, invoiceStatus: null };
  // B108: an operator's explicit-amount OrderCreditNote intents are settled HERE, at their recorded amount, before the
  // oldest-first sweep runs. settleOrderCreditsInTx clamps to the remaining balance, so money can never move twice even
  // if it already ran (e.g. at order-create time). The explicitIds exclusion below is deliberately KEPT: settling an
  // explicit intent doesn't change that the sweep must still never override it.
  if (row.orderId) {
    await creditNotes.settleOrderCreditsInTx(tx, row.orderId);
  }
  // An operator's EXPLICIT-amount order selection must not be overridden by the oldest-first sweep; null-amount intents
  // are already settled and clamp to 0.
  const explicitIds = row.orderId
    ? (
        await tx.orderCreditNote.findMany({
          where: { orderId: row.orderId, amount: { not: null } },
          select: { creditNoteId: true },
        })
      ).map((r: any) => r.creditNoteId)
    : [];
  return creditNotes.autoApplyOldestCreditsInTx(tx, id, row.customerId, {
    excludeCreditNoteIds: explicitIds,
  });
}

/**
 * SA-860: the ONE snapshot an email is built from. On the ISSUING path (locked status DRAFT) it is read inside a DRY RUN:
 * one Serializable tx that takes markSent's locks and runs the SAME send-time credits (`runSendCredits`), reads the
 * snapshot, and rolls back on purpose (`SendSnapshotRollback`), so the customer's first copy shows the balance the real
 * send will leave. Nothing is flipped and nothing commits; if the email then fails there is no money and no SENT (R5 /
 * P5-13). A re-send reads the snapshot in a short locked tx with the guard and no credits. This also replaces the SA-404a
 * pre-check (VOID => 400, no email): the same lock and guard, in the same tx.
 *
 * ⚠️ The code between the tx open and the throw must stay DB-only: no gateway, messaging, storage or email call (pinned by
 * invoice-send-snapshot.pins.spec.ts).
 */
export async function readSendSnapshot(
  prisma: PrismaService,
  creditNotes: CreditNotesService,
  id: string,
  orderId: string | null,
): Promise<{ snapshot: SendSnapshot; issuing: boolean }> {
  try {
    return await retryCreditTx(`invoice send snapshot id=${id}`, () =>
      prisma.tenantTransaction(
        async (tx) => {
          const locked = await lockInvoiceRow(tx, id, orderId);
          if (!locked) throw new NotFoundException("Invoice not found");
          const refusal = sendRefusal(locked.status);
          if (refusal) throw new BadRequestException(refusal);
          const issuing = locked.status === InvoiceStatus.DRAFT;
          if (issuing) {
            await lockCreditsForSend(tx, prisma.getTenantId(), locked);
            await runSendCredits(creditNotes, tx, id, true, locked);
          }
          const snapshot = await tx.invoice.findUnique({
            where: { id },
            include: SEND_SNAPSHOT_INCLUDE,
          });
          if (!snapshot) throw new NotFoundException("Invoice not found");
          throw new SendSnapshotRollback(snapshot as SendSnapshot, issuing);
        },
        { isolationLevel: "Serializable" },
      ),
    );
  } catch (err) {
    if (err instanceof SendSnapshotRollback)
      return { snapshot: err.snapshot, issuing: err.issuing };
    throw err;
  }
}
