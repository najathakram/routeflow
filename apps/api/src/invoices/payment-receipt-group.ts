// SA-1208 D1 (M1-02): the read-only receipt. ONE reader answers "what did this payment cover": `receiptKeyOf` names the
// kind of one row, `readReceiptGroup` returns `{kind, header, tenders[], applications[], unapplied}`. It returns the read
// shape of a future receipt header (B2), so B2 swaps only the internals. Nothing is stored and NO WRITER reads it: void
// and bounce stay per row (payment-receipt-group.pin.spec.ts). Never put it in invoices.service.ts (size ratchet).
import { NotFoundException } from "@nestjs/common";
import {
  ADVANCE_METHOD,
  CREDIT_NOTE_METHOD,
  collectedDateOf,
  roundMoney,
  sumConfirmed,
} from "@routeflow/pricing";
import type {
  PaymentListReceipt,
  ReceiptApplication,
  ReceiptGroupView,
  ReceiptHeader,
  ReceiptKind,
  ReceiptTender,
  ReceiptUnapplied,
} from "@routeflow/types";
import { PrismaService } from "../prisma/prisma.service";
import { pickupTenderGroupId } from "../orders/counter-sale/pickup-tender-group";

/** The row fields a kind is decided from (and the order the pickup id derives from). */
export interface ReceiptKeyRow {
  id: string;
  method: string;
  paymentGroupId?: string | null;
  invoice?: { orderId?: string | null } | null;
}

/** Credit uses are never a receipt. Same two methods as `groupWindowPayments`' credit rule (pinned equal in the spec, L-368). */
const isCreditUse = (method: string) => method === CREDIT_NOTE_METHOD || method === ADVANCE_METHOD;

/**
 * EXTENSION POINT (SA-749r2): the split-tender leg ids (`uuidv5(orderId:i, COUNTER_TENDER_NS)`) are not on this base, so
 * no group id can be a leg yet. When that namespace lands, its grain needs a ruling first: the pin spec fails until this
 * function knows it, so a backfill can never freeze the wrong grain.
 */
const isSplitLegGroup = (_orderId: string | null | undefined, _groupId: string): boolean => false;

/** The kind of one payment row and the key its receipt is read by. Existing predicates only, no guesswork (L-368). */
export function receiptKeyOf(p: ReceiptKeyRow): { kind: ReceiptKind; key: string } {
  const group = p.paymentGroupId ?? null;
  if (isCreditUse(p.method)) return { kind: "CREDIT_USE", key: p.id };
  if (group == null || group === "") return { kind: "SINGLE", key: p.id }; // never merged on a null or empty group (L1 of #4406)
  const orderId = p.invoice?.orderId ?? null;
  if (isSplitLegGroup(orderId, group)) return { kind: "SPLIT_LEG", key: p.id };
  if (orderId && group === pickupTenderGroupId(orderId))
    return { kind: "PICKUP_TENDERS", key: group };
  return { kind: "OFFICE_GROUP", key: group };
}

/** The numeric tail of `PAY-<tenant>-0099` (padded, so a string compare would be wrong); null without a number. */
const numberTail = (n: string | null | undefined): number | null => {
  const m = /(\d+)$/.exec(n ?? "");
  return m ? Number(m[1]) : null;
};

export const RECEIPT_INVOICE_SELECT = {
  select: {
    id: true,
    invoiceNumber: true,
    customerId: true,
    orderId: true,
    order: { select: { counterSale: true, orderNumber: true } },
  },
} as const;

export type ReceiptRow = {
  id: string;
  amount: unknown;
  method: string;
  status: string;
  reference: string | null;
  paymentNumber: string | null;
  paymentGroupId: string | null;
  checkStatus: string | null;
  createdAt: Date;
  settledAt: Date | null;
  paidAt: Date;
  creditNoteId: string | null;
  advancePaymentId: string | null;
  invoice: {
    id: string;
    invoiceNumber: string;
    customerId: string;
    orderId: string | null;
    order: { counterSale: boolean | null; orderNumber: string | null } | null;
  };
};

/** Lowest numeric payment number first (rows without one last), then creation time, then id: a stable order. */
const byNumber = (a: ReceiptRow, b: ReceiptRow): number => {
  const na = numberTail(a.paymentNumber) ?? Infinity;
  const nb = numberTail(b.paymentNumber) ?? Infinity;
  if (na !== nb) return na < nb ? -1 : 1;
  const ta = a.createdAt.getTime();
  const tb = b.createdAt.getTime();
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

const isoOrNull = (v: unknown): string | null => {
  if (v == null) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function buildView(
  kind: ReceiptKind,
  key: string,
  rows: ReceiptRow[],
  unapplied: ReceiptUnapplied,
): ReceiptGroupView {
  const sorted = [...rows].sort(byNumber);
  // scan-ok: draft-payment-not-void - a DISPLAY split (struck-through vs live) and the number's source, never a sum or a
  // capacity check: the total below reads `sumConfirmed` (PAID only), so a DRAFT row never counts toward money.
  const live = sorted.filter((r) => r.status !== "VOID");
  // The head is the lowest PAID row, else the lowest live row (SA-1220): a DRAFT number never names a receipt with a PAID row.
  const paid = sorted.filter((r) => r.status === "PAID");
  const heads = paid.length ? paid : live;
  const head = heads[0] ?? sorted[0];
  const methods = new Set(heads.map((r) => r.method));
  const numbered = heads.find((r) => numberTail(r.paymentNumber) != null);
  const reference = heads.find((r) => r.reference != null)?.reference ?? head?.reference ?? null;
  const order = head?.invoice.order ?? null;
  const header: ReceiptHeader = {
    key,
    number: numbered?.paymentNumber ?? (live.length ? reference : null),
    reference,
    method: methods.size === 1 ? [...methods][0] : null,
    receivedAt: head ? isoOrNull(collectedDateOf(head)) : null,
    customerId: head.invoice.customerId,
    orderId: kind === "PICKUP_TENDERS" ? (head.invoice.orderId ?? null) : null,
    orderNumber: kind === "PICKUP_TENDERS" ? (order?.orderNumber ?? null) : null,
    total: roundMoney(sumConfirmed(sorted)),
    confirmed: sorted.some((r) => r.status === "PAID"),
    partlyVoided: live.length > 0 && live.length < sorted.length,
  };
  const tenders = new Map<string, ReceiptTender>();
  for (const r of sorted) {
    const voided = r.status === "VOID";
    const k = `${r.method}\u0000${r.reference ?? ""}\u0000${r.status}`;
    const t = tenders.get(k) ?? {
      method: r.method,
      reference: r.reference,
      amount: 0,
      voided,
      status: r.status,
      paymentIds: [],
    };
    t.amount = roundMoney(t.amount + Number(r.amount));
    t.paymentIds.push(r.id);
    tenders.set(k, t);
  }
  return {
    kind,
    header,
    tenders: [...tenders.values()],
    applications: sorted.map(toApplication),
    unapplied,
  };
}

function toApplication(r: ReceiptRow): ReceiptApplication {
  return {
    paymentId: r.id,
    paymentNumber: r.paymentNumber,
    invoiceId: r.invoice.id,
    invoiceNumber: r.invoice.invoiceNumber,
    amount: roundMoney(Number(r.amount)),
    status: r.status,
    checkStatus: r.checkStatus,
    creditNoteId: r.creditNoteId,
    advancePaymentId: r.advancePaymentId,
  };
}

const NOT_RECORDED: ReceiptUnapplied = { amount: null, advancePaymentId: null };

/**
 * What the payment `paymentId` covered. Scope is the tenant (`forTenant()`) AND the anchor payment's customer, so a group
 * id that two customers share reads only the anchor's rows. Read-only.
 */
export async function readReceiptGroup(
  prisma: PrismaService,
  paymentId: string,
  /** The payment row when the caller already read it with `RECEIPT_INVOICE_SELECT` (L2 of #4406: no second read). */
  known?: ReceiptRow,
): Promise<ReceiptGroupView> {
  const db = prisma.forTenant();
  const anchor =
    known ??
    ((await db.invoicePayment.findUnique({
      where: { id: paymentId },
      include: { invoice: RECEIPT_INVOICE_SELECT },
    })) as ReceiptRow | null);
  if (!anchor) throw new NotFoundException("Payment not found");

  const { kind, key } = receiptKeyOf(anchor);
  if (kind === "CREDIT_USE") {
    // A credit use is a credits entry, never a receipt: no header, nothing in tenders[].
    return {
      kind,
      header: null,
      tenders: [],
      applications: [toApplication(anchor)],
      unapplied: NOT_RECORDED,
    };
  }
  if (kind === "SINGLE" || kind === "SPLIT_LEG") {
    return buildView(kind, key, [anchor], NOT_RECORDED); // one row, never merged
  }

  const customerId = anchor.invoice.customerId;
  const siblings = (await db.invoicePayment.findMany({
    where: { paymentGroupId: key, invoice: { customerId } },
    include: { invoice: RECEIPT_INVOICE_SELECT },
  })) as ReceiptRow[];
  // SA-1220: ONE key decides membership. A row is in this receipt iff its own `receiptKeyOf` is the anchor's, so every
  // row of a receipt reads the same view. No till rule here (the pin spec bans it): any method or status shows, only
  // PAID counts toward the total, and a credit use is a different kind.
  const members = siblings.filter((r) => {
    const k = receiptKeyOf(r);
    return r.invoice.customerId === customerId && k.kind === kind && k.key === key;
  });
  if (!members.some((r) => r.id === anchor.id)) members.push(anchor); // the row clicked is always on its own view
  const view = buildView(kind, key, members, NOT_RECORDED);
  if (kind === "OFFICE_GROUP" && view.header?.confirmed) {
    // Unused credit: ONLY an advance whose sourcePaymentId is a row of this group, at its ORIGINAL amount.
    const advances = await db.advancePayment.findMany({
      where: { customerId, sourcePaymentId: { in: members.map((r) => r.id) } },
      select: { id: true, amount: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], // the link is the earliest advance, not whichever the database returns first (L4 of #4406)
    });
    if (advances.length > 0) {
      view.unapplied = {
        amount: roundMoney(advances.reduce((s, a) => s + Number(a.amount), 0)),
        advancePaymentId: advances[0].id,
      };
    }
  }
  return view;
}

/** The list-row fields a receipt tag is decided from (the list query already selects them). */
interface ListReceiptRow {
  id: string;
  method: string;
  status: string;
  paymentGroupId: string | null;
  invoice: { customerId: string };
}

/**
 * M1-03: tag the CONFIRMED rows of each office check on one list page with that check's receipt figures. One receipt read
 * per (group, customer), so a group planted on two customers never merges. Rows with no group, credit uses, unconfirmed rows
 * and every other kind get no tag: they list as they always did.
 */
export async function readListReceipts(
  prisma: PrismaService,
  rows: ListReceiptRow[],
): Promise<Map<string, PaymentListReceipt>> {
  const tagKey = (r: ListReceiptRow) => `${r.paymentGroupId}\u0000${r.invoice.customerId}`;
  const eligible = rows.filter(
    (r) => r.paymentGroupId && r.status === "PAID" && !isCreditUse(r.method),
  );
  const anchors = new Map<string, string>();
  for (const r of eligible) if (!anchors.has(tagKey(r))) anchors.set(tagKey(r), r.id);
  const tags = new Map<string, PaymentListReceipt>();
  const list = [...anchors];
  const views: Awaited<ReturnType<typeof readReceiptGroup>>[] = [];
  for (let i = 0; i < list.length; i += 8) {
    const chunk = list.slice(i, i + 8); // at most 8 receipt reads in flight (a page may hold 1,000 rows)
    views.push(...(await Promise.all(chunk.map(([, id]) => readReceiptGroup(prisma, id)))));
  }
  list.forEach(([k], i) => {
    const view = views[i];
    if (view.kind !== "OFFICE_GROUP" || !view.header?.confirmed) return;
    const seen = new Set<string>();
    const invoices = view.applications
      .filter((a) => a.status === "PAID" && !seen.has(a.invoiceId) && seen.add(a.invoiceId))
      .map((a) => ({ id: a.invoiceId, invoiceNumber: a.invoiceNumber }));
    tags.set(k, {
      key: view.header.key,
      number: view.header.number,
      total: view.header.total,
      invoices,
    });
  });
  const byRow = new Map<string, PaymentListReceipt>();
  for (const r of eligible) {
    const tag = tags.get(tagKey(r));
    if (tag) byRow.set(r.id, tag);
  }
  return byRow;
}
