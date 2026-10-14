import { createHash } from "node:crypto";
import { BadRequestException, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { CONFIRMED_PAYMENT, round4, roundMoney, splitConfirmed } from "@routeflow/pricing";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { resolvePendingMirror } from "./pending-mirror";
import { BILL_TO_ADDRESS_ORDER } from "./invoice-bill-to";
import { invoiceItemCode } from "./invoice-item-code";
import { resolveInvoiceVariant } from "./invoice-stage";

/**
 * Owner issue #2088: re-emailing an invoice, with "sent before, modified since" vs "no changes since".
 *
 * RECORD: one AuditLog row per delivered email (`invoice.emailed`, entityType "invoice", meta {to, fp, sentAt}). It is
 * append-only and survives a DRAFT revert, which nulls `Invoice.sentAt`; no migration. The write is best-effort AFTER
 * the transport reported delivered: a failed audit write is logged and never fails the send (the email went).
 *
 * FINGERPRINT: a versioned hash of exactly what renders on the customer's PDF / email. `v1:<sha256>`; only the same
 * version is compared, so a later field change cannot flip every invoice to "changed" - a missing or different
 * version reads as `sentBeforeTracking` (emailed, changes cannot be checked). The DRAFT / FINAL stage is part of it (a
 * final after a proforma is a different document). Internal-only fields (internal notes, override reasons, restriction
 * stamps, cost/margin, updatedAt) are NEVER part of it.
 *
 * A `sentAt` with NO tracked row is two different things: before `TRACKING_SINCE` it is an old send we cannot check
 * (`sentBeforeTracking`); on/after it, every real email has a row, so it was only MARKED sent (`markedSentNotEmailed`:
 * Mark as Sent, a counter sale, a pickup hand-over, a deposit invoice).
 */

export const FINGERPRINT_VERSION = "v1";
/** Per-invoice email throttle: at most this many emails in the window (a double-tap or a loop cannot spam a customer). */
export const SEND_THROTTLE_MAX = 5;
export const SEND_THROTTLE_WINDOW_MS = 15 * 60_000;
/**
 * When email tracking started: the release of #2088. MUST be on/after the deploy of this change (bump it if the release
 * slips): a real email sent between this instant and the deploy would read as "marked sent, not emailed".
 */
export const TRACKING_SINCE = new Date("2026-10-20T00:00:00.000Z");

const logger = new Logger("invoice-send-state");

export type InvoiceSendStateName =
  "never" | "unchanged" | "changedSinceSent" | "sentBeforeTracking" | "markedSentNotEmailed";
export interface InvoiceSendState {
  state: InvoiceSendStateName;
  lastSentAt: string | null;
  lastSentTo: string | null;
}

type Num = number | string | { toString(): string } | null | undefined;
const money = (v: Num): number | null => (v == null ? null : roundMoney(Number(v.toString())));
const rate4 = (v: Num): number | null => (v == null ? null : round4(Number(v.toString())));
const qty3 = rate4; // a quantity has at most 3 decimals; round4 is a superset and the shared rounding helper
const text = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};
const day = (v: Date | string | null | undefined): string | null =>
  v == null ? null : new Date(v).toISOString().slice(0, 10);

/** The invoice as the fingerprint reads it: everything is optional so any caller's include shape works. */
export interface FingerprintSource {
  invoiceNumber?: string | null;
  issueDate?: Date | string | null;
  dueDate?: Date | string | null;
  paymentTermsLabel?: string | null;
  /** "draft" | "final": the PDF / email stage this fingerprint is for (a final after a proforma is a new document). */
  variant?: string | null;
  notes?: string | null;
  terms?: string | null;
  subtotal?: Num;
  taxAmount?: Num;
  discount?: Num;
  shippingFee?: Num;
  total?: Num;
  depositPercent?: Num;
  depositDueDate?: Date | string | null;
  shippingCarrier?: string | null;
  shippingTrackingNumber?: string | null;
  customer?: {
    businessName?: string | null;
    contactName?: string | null;
    phone?: string | null;
    addresses?: ReadonlyArray<{
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      zip?: string | null;
    }> | null;
  } | null;
  items?: ReadonlyArray<{
    id?: string;
    description?: string | null;
    notes?: string | null;
    qty?: Num;
    boxes?: Num;
    pieces?: Num;
    unitsPerBox?: Num;
    unitLabel?: string | null;
    unitPrice?: Num;
    discount?: Num;
    originalPrice?: Num;
    msrp?: Num;
    priceType?: string | null;
    promoFreeUnits?: Num;
    taxRate?: Num;
    subtotal?: Num;
    categoryTaxAmount?: Num;
    trackedCategory?: { name?: string | null } | null;
    /** The printed item code (barcode / SKU), read live from the product like the PDF does. */
    product?: { unitSku?: string | null; barcode?: string | null; sku?: string | null } | null;
    components?: ReadonlyArray<{
      name?: string | null;
      qty?: Num;
      position?: number;
    }> | null;
  }> | null;
  /** The PDF's payment listing (every non-VOID row); the confirmed ones also feed Amount Paid / Balance Due. */
  payments?: ReadonlyArray<{
    amount?: Num;
    method?: string | null;
    status?: string | null;
    paidAt?: Date | string | null;
    reference?: string | null;
  }> | null;
}

/** The canonical, customer-visible content. Field order is fixed here, so the JSON (and the hash) is stable. */
export function fingerprintContent(src: FingerprintSource): unknown {
  const addr = src.customer?.addresses?.[0];
  const listed = src.payments ?? [];
  const paid = splitConfirmed(listed.filter((p) => p.status === CONFIRMED_PAYMENT.status) as never);
  return {
    n: text(src.invoiceNumber),
    issued: day(src.issueDate),
    due: day(src.dueDate),
    terms: text(src.paymentTermsLabel),
    variant: text(src.variant),
    notes: text(src.notes),
    conditions: text(src.terms),
    subtotal: money(src.subtotal),
    tax: money(src.taxAmount),
    discount: money(src.discount),
    fee: money(src.shippingFee),
    total: money(src.total),
    deposit: [rate4(src.depositPercent), day(src.depositDueDate)],
    ship: [text(src.shippingCarrier), text(src.shippingTrackingNumber)],
    billTo: [
      text(src.customer?.businessName),
      text(src.customer?.contactName),
      text(src.customer?.phone),
      addr
        ? [text(addr.line1), text(addr.line2), text(addr.city), text(addr.state), text(addr.zip)]
        : null,
    ],
    paid: [money(paid.cash), money(paid.creditApplied), money(paid.advanceApplied)],
    // the PDF's Payment History lists every non-VOID row, a DRAFT one as "pending confirmation"
    payments: listed.map((p) => [
      text(p.method),
      text(p.status),
      money(p.amount),
      day(p.paidAt),
      text(p.reference),
    ]),
    items: (src.items ?? []).map((it) => [
      text(it.description),
      text(it.notes),
      qty3(it.qty),
      it.boxes == null ? null : Number(it.boxes.toString()),
      it.pieces == null ? null : Number(it.pieces.toString()),
      it.unitsPerBox == null ? null : Number(it.unitsPerBox.toString()),
      text(it.unitLabel),
      money(it.unitPrice),
      money(it.discount),
      money(it.originalPrice),
      money(it.msrp),
      text(it.priceType),
      it.promoFreeUnits == null ? null : Number(it.promoFreeUnits.toString()),
      rate4(it.taxRate),
      money(it.subtotal),
      money(it.categoryTaxAmount),
      text(it.trackedCategory?.name),
      text(invoiceItemCode(it.product)),
      (it.components ?? [])
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((c) => [text(c.name), qty3(c.qty)]),
    ]),
  };
}

/** `v1:<sha256 hex>` of the customer-visible content. */
export function invoiceFingerprint(src: FingerprintSource): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(fingerprintContent(src)))
    .digest("hex");
  return `${FINGERPRINT_VERSION}:${hash}`;
}

/** The invoice include that carries every field `invoiceFingerprint` reads. */
export const FINGERPRINT_INCLUDE = {
  customer: {
    select: {
      businessName: true,
      contactName: true,
      phone: true,
      addresses: { orderBy: BILL_TO_ADDRESS_ORDER, take: 1 },
    },
  },
  items: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    include: {
      trackedCategory: { select: { name: true } },
      product: { select: { unitSku: true, barcode: true, sku: true } },
      components: { orderBy: { position: "asc" as const } },
    },
  },
  // the PDF's Payment History: every non-VOID row (the confirmed ones also feed Amount Paid / Balance Due)
  payments: { where: { status: { not: "VOID" as const } }, orderBy: { paidAt: "asc" as const } },
  order: { select: { status: true, fulfillPath: true, shippedAt: true } },
} as const;

/**
 * Reads the invoice with `FINGERPRINT_INCLUDE` and fingerprints it for `variant` (the stage the PDF / email is for;
 * undefined = the stage a plain send would use, resolved exactly like the PDF does). Null when the invoice does not exist.
 */
export async function invoiceFingerprintOf(
  prisma: PrismaLike,
  featureConfig: any,
  invoiceId: string,
  variant?: string,
): Promise<string | null> {
  const inv = await prisma.forTenant().invoice.findUnique({
    where: { id: invoiceId },
    include: FINGERPRINT_INCLUDE,
  });
  if (!inv) return null;
  const stage =
    variant ?? (await resolveInvoiceVariant(featureConfig, prisma.getTenantId(), inv, inv.order));
  return invoiceFingerprint({ ...inv, variant: stage });
}

type EmailRow = { createdAt: Date; meta: unknown };
const metaOf = (row: EmailRow): { to: string | null; fp: string | null } => {
  const m = (row.meta ?? {}) as { to?: unknown; fp?: unknown };
  return {
    to: typeof m.to === "string" ? m.to : null,
    fp: typeof m.fp === "string" ? m.fp : null,
  };
};

/**
 * The pure decision. `last` = the newest tracked email row (or null); `current` = the invoice's fingerprint now;
 * `legacySentAt` = `Invoice.sentAt` (an invoice emailed before tracking has it but no row).
 */
export function decideSendState(
  last: EmailRow | null,
  current: string | null,
  legacySentAt: Date | null,
): InvoiceSendState {
  if (last) {
    const { to, fp } = metaOf(last);
    const sameVersion = fp != null && current != null && fp.startsWith(`${FINGERPRINT_VERSION}:`);
    return {
      state: !sameVersion
        ? "sentBeforeTracking"
        : fp === current
          ? "unchanged"
          : "changedSinceSent",
      lastSentAt: last.createdAt.toISOString(),
      lastSentTo: to,
    };
  }
  if (legacySentAt) {
    // No row: before tracking began this may well have been an email (changes cannot be checked); on/after it every
    // real email has a row, so this send was only MARKED (Mark as Sent, counter sale, pickup hand-over, deposit).
    return {
      state: legacySentAt < TRACKING_SINCE ? "sentBeforeTracking" : "markedSentNotEmailed",
      lastSentAt: legacySentAt.toISOString(),
      lastSentTo: null,
    };
  }
  return { state: "never", lastSentAt: null, lastSentTo: null };
}

/** The newest tracked email row of an invoice (tenant-scoped through the caller's client). */
export function lastEmailRow(db: any, tenantId: string | null | undefined, invoiceId: string) {
  return db.auditLog.findFirst({
    where: {
      ...(tenantId ? { tenantId } : {}),
      entityType: "invoice",
      entityId: invoiceId,
      action: AUDIT_ACTIONS.INVOICE_EMAILED,
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, meta: true },
  }) as Promise<EmailRow | null>;
}

/** What the detail read returns as `sendState`. */
export async function readSendState(
  prisma: PrismaLike,
  featureConfig: any,
  inv: { id: string; sentAt: Date | null },
): Promise<InvoiceSendState> {
  const last = await lastEmailRow(prisma.forTenant(), prisma.getTenantId(), inv.id);
  const current = last ? await invoiceFingerprintOf(prisma, featureConfig, inv.id) : null;
  return decideSendState(last, current, inv.sentAt);
}

/** `sendEmail`'s arguments: (invoice id, address override, PDF variant, the sender's user id for the record). */
export type SendEmailArgs = [
  id: string,
  overrideEmail?: string,
  variant?: "draft" | "final",
  actorId?: string | null,
];

type PrismaLike = { forTenant(): any; getTenantId(): string | null | undefined };

/** Best-effort audit write AFTER the email was delivered: a failed write is logged, never thrown. */
export async function recordInvoiceEmailed(
  prisma: PrismaLike,
  p: {
    id: string;
    actorId: string | null;
    to: string;
    fingerprint: string | null;
    variant?: string | null;
  },
): Promise<void> {
  const tenantId = prisma.getTenantId();
  try {
    await prisma.forTenant().auditLog.create({
      data: {
        ...(tenantId ? { tenantId } : {}),
        userId: p.actorId,
        action: AUDIT_ACTIONS.INVOICE_EMAILED,
        entityType: "invoice",
        entityId: p.id,
        meta: {
          to: p.to,
          fp: p.fingerprint,
          sentAt: new Date().toISOString(),
          ...(p.variant ? { variant: p.variant } : {}),
        },
      },
    });
  } catch (err) {
    logger.error(
      `invoice ${p.id}: the email went out but its send record could not be written: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ── per-invoice throttle ─────────────────────────────────────────────────────

/** In-process guard for a double-tap: a second send for the SAME invoice while one is in flight. */
const inFlight = new Set<string>();

export function throttled(): HttpException {
  return new HttpException(
    {
      code: API_ERROR_CODES.EMAIL_SEND_THROTTLED,
      message:
        "This invoice was just emailed several times. Wait a few minutes before emailing it again.",
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Refuses (429) when this invoice already went out `SEND_THROTTLE_MAX` times in the window (counted from the audit
 * rows, so it holds across replicas) or when a send for it is already in flight in this process. Returns the release
 * function the caller MUST call in a `finally`.
 */
export async function acquireSendSlot(
  db: any,
  tenantId: string | null | undefined,
  invoiceId: string,
  now: Date = new Date(),
): Promise<() => void> {
  if (inFlight.has(invoiceId)) throw throttled();
  inFlight.add(invoiceId);
  try {
    const recent = await db.auditLog.count({
      where: {
        ...(tenantId ? { tenantId } : {}),
        entityType: "invoice",
        entityId: invoiceId,
        action: AUDIT_ACTIONS.INVOICE_EMAILED,
        createdAt: { gte: new Date(now.getTime() - SEND_THROTTLE_WINDOW_MS) },
      },
    });
    if (recent >= SEND_THROTTLE_MAX) throw throttled();
  } catch (err) {
    inFlight.delete(invoiceId);
    throw err;
  }
  return () => {
    inFlight.delete(invoiceId);
  };
}

// ── the pre-delivery lock (ONE predicate for the guard and the read) ─────────────────────────────

/**
 * Is the Send action locked because this order-linked DRAFT mirrors an order that has not been delivered yet (the
 * "pending mirror")? `assertOrderInvoiceUnlocked` (refusal) and the detail read (`sendLocked`) both call this, so
 * what the screen explains is exactly what the server refuses.
 */
export async function sendLockedByOrder(
  deps: { featureConfig: any; tenantId: string | null | undefined },
  inv: { orderId: string | null; status: InvoiceStatus; deliveryBatchId: string | null },
  order: { status?: unknown; fulfillPath?: unknown } | null | undefined,
): Promise<boolean> {
  if (!inv.orderId || inv.status !== InvoiceStatus.DRAFT || inv.deliveryBatchId != null)
    return false;
  if (!order) return false;
  return Boolean(
    await resolvePendingMirror(deps.featureConfig, deps.tenantId, inv as never, order as never),
  );
}

/** `sendEmail`'s guard: the per-invoice throttle around the whole delivery. */
export async function guardedEmail<T>(
  prisma: PrismaLike,
  invoiceId: string,
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireSendSlot(prisma.forTenant(), prisma.getTenantId(), invoiceId);
  try {
    return await run();
  } finally {
    release();
  }
}

/** The two fields the detail read adds: the tracked send state and the pre-delivery lock. */
export async function sendFieldsFor(
  prisma: PrismaLike,
  featureConfig: any,
  inv: {
    id: string;
    sentAt: Date | null;
    orderId: string | null;
    status: InvoiceStatus;
    deliveryBatchId: string | null;
  },
  order: { status?: unknown; fulfillPath?: unknown } | null | undefined,
): Promise<{ sendState: InvoiceSendState; sendLocked: { reason: "SENDS_AFTER_DELIVERY" } | null }> {
  const tenantId = prisma.getTenantId();
  const locked = await sendLockedByOrder({ featureConfig, tenantId }, inv, order);
  return {
    sendState: await readSendState(prisma, featureConfig, inv),
    sendLocked: locked ? { reason: "SENDS_AFTER_DELIVERY" } : null,
  };
}

/**
 * The refusal behind `sendLocked`: an order-linked DRAFT that mirrors an un-delivered order cannot be sent or edited
 * (400). `allowPreDelivery` is the narrow WP-D1 escape hatch for the deposit-collect-at-order issuance only.
 */
export async function assertOrderInvoiceUnlockedFor(
  prisma: PrismaLike,
  featureConfig: any,
  inv: { orderId: string | null; status: InvoiceStatus; deliveryBatchId: string | null },
  opts?: { allowPreDelivery?: boolean },
): Promise<void> {
  if (!inv.orderId || inv.status !== InvoiceStatus.DRAFT || inv.deliveryBatchId != null) return;
  if (opts?.allowPreDelivery) return;
  const order = await prisma.forTenant().order.findFirst({
    where: { id: inv.orderId },
    select: { status: true, orderNumber: true, fulfillPath: true },
  });
  if (
    order &&
    (await sendLockedByOrder({ featureConfig, tenantId: prisma.getTenantId() }, inv, order))
  ) {
    throw new BadRequestException(
      `This invoice mirrors order #${order.orderNumber ?? ""} and can't be sent or edited until the order is delivered. Edit the order instead — the invoice updates automatically.`,
    );
  }
}
