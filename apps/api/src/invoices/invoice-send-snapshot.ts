import type { Prisma } from "@prisma/client";
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
