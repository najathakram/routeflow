import { InvoiceStatus } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isNsfLine } from "./nsf-line";

/**
 * The ONE place that decides whether an order's invoices are a clean per-line partition, shared by
 * the delivered-basis rebuild (reconcileOrderDeliveredInvoices) and the legacy single-draft rebuild
 * (reconcileOrderDraftInvoice). SA-681: that legacy rebuild used to fold the OLDEST open draft onto
 * the FULL order while sibling partials kept billing their share (a 10-box order split 6/4 billed
 * 14 boxes). It now runs only for a draft that is the order's sole billing invoice.
 */

/** What reconcileOrderDraftInvoice returns when the order's invoices are partials it must not touch. */
export const RECONCILE_PARTIALS = "partials" as const;
export type ReconcilePartials = typeof RECONCILE_PARTIALS;

export interface PartitionInvoice {
  id?: string;
  status: InvoiceStatus;
  deliveryBatchId?: string | null;
  items?: Array<{ orderItemId?: string | null }> | null;
}

/** An open pending-mirror / sibling draft: DRAFT and not a delivery-batch invoice. */
export const isOpenOrderDraft = (i: PartitionInvoice): boolean =>
  i.status === InvoiceStatus.DRAFT && i.deliveryBatchId == null;

/**
 * True when every order line is billed by exactly ONE of the order's non-void `invoices`, and only
 * by an open draft. Provenance is the invoice item's `orderItemId`. Not clean when:
 *   - any invoice line carries no orderItemId (legacy / freeform): the partition cannot be proven;
 *   - a draft line is also billed by a finalized (non-open-draft) invoice;
 *   - a line is shared across two open drafts (createPartialFromOrder: 6 + 4 of one line).
 * Extracted verbatim from reconcileOrderDeliveredInvoices.
 */
export function isCleanDraftPartition(invoices: PartitionInvoice[]): boolean {
  const drafts = invoices.filter(isOpenOrderDraft);
  const finalized = invoices.filter((i) => !isOpenOrderDraft(i));
  const hasUntracked = (i: PartitionInvoice) => (i.items ?? []).some((it) => !it.orderItemId);
  if (finalized.some(hasUntracked) || drafts.some(hasUntracked)) return false;
  const finalizedLineIds = new Set<string>(
    finalized.flatMap((i) => (i.items ?? []).map((it) => it.orderItemId as string)).filter(Boolean),
  );
  const seen = new Set<string>();
  for (const d of drafts) {
    for (const it of d.items ?? []) {
      const id = it.orderItemId as string;
      if (seen.has(id) || finalizedLineIds.has(id)) return false;
      seen.add(id);
    }
  }
  return true;
}

/**
 * The legacy rebuild's fence: `draftId` is the order's SOLE non-void invoice — the lone-draft case
 * of the clean partition above. The draft's own untracked NSF fee lines do not disqualify it,
 * because that rebuild keeps exactly those (preservedNsfLines); any other untracked line on it is
 * replaced by the rebuild, as it always was for a sole draft. `invoices` are
 * the order's non-void invoices; an empty list means nothing else bills the order.
 */
export function isSoleBillingDraft(draftId: string, invoices: PartitionInvoice[]): boolean {
  return !invoices.some((i) => i.id !== draftId);
}

/**
 * True when the draft's lines bill LESS than the order's lines — a line missing from it, or billed
 * for part of its qty: the signature of a partial invoice rather than a mirror of the whole order.
 * Only meaningful when nothing has just edited the order (Mark Delivered), because a mirror is
 * otherwise short only transiently, between an order edit and its own reconcile. ONE deliberate
 * exception (SA-687): a delivered-basis mirror (a driver's short delivery, then a manual Mark
 * Delivered from PARTIALLY_DELIVERED) bills the delivered qty, so it reads as short here and Mark
 * Delivered now bills mirror + ONE remainder invoice instead of one rebuilt invoice — the same
 * total, two invoices (pinned in split-invoice-no-rebuild-sa681.spec.ts).
 */
export function draftBillsLessThanOrder(
  draftItems: Array<{ orderItemId?: string | null; qty?: unknown }>,
  orderLines: Array<{ id: string; qty?: unknown }>,
): boolean {
  const billed = new Map<string, number>();
  for (const it of draftItems) {
    if (!it.orderItemId) continue;
    billed.set(it.orderItemId, (billed.get(it.orderItemId) ?? 0) + Number(it.qty ?? 0));
  }
  return orderLines.some((li) => {
    const qty = Number(li.qty ?? 0);
    return qty > 0.001 && (billed.get(li.id) ?? 0) < qty - 0.001;
  });
}

/** SA-687: the 409 for "more would be billed on an order whose invoices no longer match its lines". */
export const ORDER_INVOICES_NEED_REVIEW_MESSAGE =
  "This order's invoices don't match its lines. Add the remaining items to the draft, or void and re-split, before billing more.";
export const orderInvoicesNeedReviewError = () =>
  new ConflictException({
    code: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW,
    message: ORDER_INVOICES_NEED_REVIEW_MESSAGE,
  });

/** True for the 409 above. The driver's stop completion catches it (the status write never depends on the invoice). */
export const isOrderInvoicesNeedReview = (err: unknown): boolean =>
  err instanceof ConflictException &&
  (err.getResponse() as { code?: string })?.code === API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW;

/**
 * SA-687: can the order's "qty - invoicedQty" be trusted before more is billed beside its existing
 * invoices? No when any non-void invoice:
 *   - ORPHANED (only while a remainder exists to bill): carries a line that looks like an order
 *     line but has NO orderItemId. A replace-all order edit deletes and re-creates every OrderItem
 *     (invoicedQty back to 0) and InvoiceItem.orderItemId is onDelete SetNull, so the invoices keep
 *     billing through lines the counter no longer knows about (the remainder would bill the whole
 *     order again). "Looks like an order line" = productId set, or its description equals a live
 *     custom (unlisted) line's name; an NSF line or a freeform fee/surcharge line never counts;
 *   - leaves a live line with invoicedQty above its qty (a line cut below what is invoiced), or
 *     different from what the invoices actually bill on that line (the counter is out of step);
 *     these counter tests apply even when nothing remains.
 * No invoice at all is trivially fine. `onlyWhenRemainder` skips the whole check when nothing remains
 * to bill (the create paths then bill nothing anyway). Used by Mark Delivered (every path that
 * reaches the remainder create, with or without an open draft), createPartialFromOrder and
 * createInvoiceFromOrder ("Generate Invoice (full order)").
 */
export async function invoicesNeedReview(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tenant (transaction) client
  db: any,
  orderId: string,
  opts: { onlyWhenRemainder?: boolean } = {},
): Promise<boolean> {
  const invoices: Array<{ items: Array<Record<string, any>> }> = await db.invoice.findMany({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
    select: {
      items: {
        select: {
          orderItemId: true,
          productId: true,
          systemKind: true,
          description: true,
          qty: true,
        },
      },
    },
  });
  if (invoices.length === 0) return false;
  const lines: Array<{ id: string; name?: string | null; qty: unknown; invoicedQty: unknown }> =
    await db.orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      select: { id: true, name: true, qty: true, invoicedQty: true },
    });
  const hasRemainder = lines.some(
    (li) => Number(li.qty ?? 0) - Number(li.invoicedQty ?? 0) > 0.001,
  );
  if (opts.onlyWhenRemainder && !hasRemainder) return false;

  const items = invoices.flatMap((i) => i.items ?? []);
  // KNOWN GAPS (B1090 follow-up): an unlisted (productId null) invoice line is recognised only by its
  // description matching a live custom line's name, so the orphan test is bypassed when (1) the
  // custom line is RENAMED in the same replace-all edit, or (2) staff edited that draft line's
  // description before the replace-all. Both leave the remainder to bill unguarded; pinned as-is in
  // invoice-partition-known-gaps.spec.ts so a later fix flips them deliberately.
  const customNames = new Set(lines.filter((li) => li.name).map((li) => li.name));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- an invoice item row as selected above
  const looksLikeOrderLine = (it: Record<string, any>) =>
    !!it.productId || customNames.has(it.description);
  if (
    hasRemainder &&
    items.some((it) => !it.orderItemId && !isNsfLine(it) && looksLikeOrderLine(it))
  ) {
    return true;
  }
  const billed = new Map<string, number>();
  for (const it of items) {
    if (it.orderItemId)
      billed.set(it.orderItemId, (billed.get(it.orderItemId) ?? 0) + Number(it.qty));
  }
  return lines.some((li) => {
    const invoiced = Number(li.invoicedQty ?? 0);
    return (
      invoiced > Number(li.qty ?? 0) + 0.001 ||
      Math.abs((billed.get(li.id) ?? 0) - invoiced) > 0.001
    );
  });
}

/** The billing writers' guard: refuse (409 ORDER_INVOICES_NEED_REVIEW, nothing written) when the invoices need review. */
export async function assertOrderInvoicesInStep(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tenant client
  db: any,
  orderId: string,
  opts: { onlyWhenRemainder?: boolean } = {},
): Promise<void> {
  if (await invoicesNeedReview(db, orderId, opts)) throw orderInvoicesNeedReviewError();
}

/**
 * reconcileOrderDraftInvoice's SA-681 fence on the DB: `draftId` is the order's sole non-void
 * invoice (see isSoleBillingDraft). Kept here so the service stays under its size ceiling.
 */
export async function isSoleBillingDraftIn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tenant (transaction) client
  db: any,
  orderId: string,
  draftId: string,
): Promise<boolean> {
  const nonVoid: PartitionInvoice[] = await db.invoice.findMany({
    where: { orderId, status: { not: InvoiceStatus.VOID } },
    select: { id: true },
  });
  return isSoleBillingDraft(draftId, nonVoid);
}

/** What `placeUnbilledLines` needs from a draft: its id and the invoice lines it still holds. */
export interface PlacementDraft {
  id: string;
  items?: Array<{ orderItemId?: string | null; trackedCategoryId?: string | null }> | null;
}

/**
 * SA-1098 A-3: a delivered-basis rebuild keeps only the lines that bill above 0, so a line delivered
 * at 0 (refused, then undone) loses its invoice item, and the next completion reads a draft's lines
 * from the items it still holds and never sees it again. This decides, WITHOUT touching the DB,
 * which draft each live order line that NO non-void invoice bills goes back on before the rebuild
 * (the only reads are the caller's own `groupsOf`, called only when several drafts need it).
 * The rebuild's own filter still drops a line delivered at 0, so a refused line never bills.
 *
 *   - one draft: every unbilled line goes on it;
 *   - several drafts: a line goes on the draft that holds its group's category (`groupsOf` is the one
 *     grouping function's answer over the live lines: the standard group first, then each
 *     SEPARATE_INVOICE category in numbering order). When a draft has no items left, the category
 *     cannot be read, so the group order is matched against the draft order (base, -R1, -R2) and
 *     only when the group count equals the draft count;
 *   - anything less certain (counts differ, two separate categories on one draft, a draft whose
 *     category is not the group at its position): the line is left OFF and `needsReview` is set,
 *     never guessed and never folded.
 *
 * `invoices` is every non-void invoice of the order, `drafts` the open ones in creation order.
 */
export async function placeUnbilledLines(input: {
  invoices: Array<{ items?: Array<{ orderItemId?: string | null }> | null }>;
  drafts: PlacementDraft[];
  lineIds: string[];
  groupsOf: () => Promise<Array<{ trackedCategoryId: string | null; lineIds: string[] }>>;
}): Promise<{ placed: Map<string, string[]>; needsReview: boolean }> {
  const placed = new Map<string, string[]>();
  const billed = new Set<string>(
    input.invoices.flatMap((i) => (i.items ?? []).map((it) => it.orderItemId as string)),
  );
  const unbilled = input.lineIds.filter((id) => !billed.has(id));
  if (unbilled.length === 0 || input.drafts.length === 0) return { placed, needsReview: false };
  const put = (draftId: string, lineId: string) =>
    placed.set(draftId, [...(placed.get(draftId) ?? []), lineId]);

  if (input.drafts.length === 1) {
    for (const id of unbilled) put(input.drafts[0].id, id);
    return { placed, needsReview: false };
  }

  const { drafts } = input;
  const groups = await input.groupsOf();
  const sepCats = new Set(groups.map((g) => g.trackedCategoryId).filter(Boolean));
  // A draft's category: the one separate category its items carry, null for the base, undefined if ambiguous.
  const catOf = (d: PlacementDraft): string | null | undefined => {
    const cats = new Set<string>();
    for (const it of d.items ?? []) {
      if (it.trackedCategoryId && sepCats.has(it.trackedCategoryId)) cats.add(it.trackedCategoryId);
    }
    if (cats.size > 1) return undefined;
    return cats.size === 1 ? [...cats][0] : null;
  };
  const anyEmpty = drafts.some((d) => (d.items ?? []).length === 0);
  const draftForGroup = new Map<string | null, string>();
  if (groups.length !== drafts.length) return { placed, needsReview: true };
  if (anyEmpty) {
    // by position; a draft that still holds items must agree with the group at its position
    for (const [i, d] of drafts.entries()) {
      if ((d.items ?? []).length > 0 && catOf(d) !== groups[i].trackedCategoryId) {
        return { placed, needsReview: true };
      }
      draftForGroup.set(groups[i].trackedCategoryId, d.id);
    }
  } else {
    for (const d of drafts) {
      const c = catOf(d);
      if (c === undefined || draftForGroup.has(c)) return { placed, needsReview: true };
      draftForGroup.set(c, d.id);
    }
  }
  let needsReview = false;
  for (const g of groups) {
    const draftId = draftForGroup.get(g.trackedCategoryId);
    for (const id of g.lineIds) {
      if (!unbilled.includes(id)) continue;
      if (draftId) put(draftId, id);
      else needsReview = true;
    }
  }
  return { placed, needsReview };
}

/**
 * The service's one call: place the unbilled live lines (see `placeUnbilledLines`) using the one grouping
 * function, and write the needs-review audit row when a line had to be left off. Returns, per draft id,
 * the order-line ids that draft is rebuilt from: the lines it still holds plus the ones placed on it.
 */
export async function placeUnbilledLinesFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tenant (transaction) client
  db: any,
  orderId: string,
  input: {
    invoices: Array<{ items?: Array<{ orderItemId?: string | null }> | null }>;
    drafts: PlacementDraft[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the order's live lines, as loaded
    lines: any[];
    groupLines: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the grouping function's own shape
      items: Array<{ li: any; remainingQty: number }>,
    ) => Promise<Array<{ trackedCategoryId: string | null; items: Array<{ li: { id: string } }> }>>;
  },
): Promise<Map<string, string[]>> {
  const { placed, needsReview } = await placeUnbilledLines({
    invoices: input.invoices,
    drafts: input.drafts,
    lineIds: input.lines.map((li) => li.id),
    groupsOf: async () =>
      (await input.groupLines(input.lines.map((li) => ({ li, remainingQty: 1 })))).map((g) => ({
        trackedCategoryId: g.trackedCategoryId,
        lineIds: g.items.map((x) => x.li.id),
      })),
  });
  if (needsReview) await flagUnplacedLines(db, orderId);
  return new Map(
    input.drafts.map((d) => [
      d.id,
      [
        ...new Set([
          ...(d.items ?? []).map((it) => it.orderItemId).filter((id): id is string => !!id),
          ...(placed.get(d.id) ?? []),
        ]),
      ],
    ]),
  );
}

/** `meta.kind` of the row below: the marker the office's order read looks for (SA-1098 A-3, never the note's text). */
export const LINE_LEFT_OFF_KIND = "line-left-off";

/** The same audit row the stop completion writes when it cannot create an invoice (SA-687c), for a line left off. */
export async function flagUnplacedLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tenant (transaction) client
  db: any,
  orderId: string,
): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: null,
      action: API_ERROR_CODES.ORDER_INVOICES_NEED_REVIEW,
      entityType: "order",
      entityId: orderId,
      meta: {
        context: "stop-completion",
        kind: LINE_LEFT_OFF_KIND,
        note: "a delivered line is on no invoice and could not be placed on a draft",
      },
    },
  });
}
