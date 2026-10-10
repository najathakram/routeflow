import { BadRequestException, Injectable } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import {
  calendarDateFromIso,
  isoFromCalendarDate,
  startOfCalendarDay,
  startOfLocalDay,
} from "../common/calendar-date";
import {
  ACCRUAL_CREDIT_NOTE_FILTER,
  ACCRUAL_REVENUE_STATUSES,
  EXTERNAL_REFUND_FILTER,
  roundQty,
} from "../common/invoiced-sales";
import { addCalendarDays } from "../analytics/demand-range";
import { standardRestockResolver } from "../returns/returns-restock-pieces";
import {
  type LineKey,
  attributeCreditNote,
  attributeExternalRefund,
  compareLineKeysDesc,
  lineKeyOf,
  returnNettingDate,
  salePiecesOf,
} from "./sales-facts.rules";
import type {
  AttributedCreditEvent,
  InstantWindow,
  ProductCreditEvents,
  ProductLifetime,
  ProductPeriodStats,
  ProductSaleFact,
  ReturnedQtyEvent,
  UnattributedCreditEvent,
} from "./sales-facts.types";

/**
 * `ACCRUAL_REVENUE_STATUSES` (DRAFT/VOID out, WRITTEN_OFF in — plan A2) as the MUTABLE filter
 * the typed Prisma client accepts: the shared constant is `as const` (its readonly tuple only
 * type-checks against the untyped `AccrualSalesDb` stubs). Derived, never restated (L-167).
 */
const ACCRUAL_STATUS_FILTER = { notIn: [...ACCRUAL_REVENUE_STATUSES.notIn] };

/** Line ids per `IN` list — far below Postgres's bind-parameter ceiling. */
const LINE_ID_CHUNK = 5_000;

/**
 * The one product-line projection every reader shares (legacy delegates included). The two
 * relation reads are optional because each costs a query per page of invoices: a line page
 * shows order numbers and names, insights need names only, the demand chart neither.
 */
function saleFactSelect(
  productId: string,
  include: { orderNumber: boolean; customerName: boolean },
) {
  return {
    id: true,
    invoiceNumber: true,
    status: true,
    issueDate: true,
    createdAt: true,
    orderId: true,
    ...(include.orderNumber ? { order: { select: { orderNumber: true } } } : {}),
    customerId: true,
    ...(include.customerName ? { customer: { select: { id: true, businessName: true } } } : {}),
    items: {
      // Only this product's lines; `productId` equality never matches an unlisted (null) line.
      where: { productId },
      select: {
        id: true,
        createdAt: true,
        qty: true,
        subtotal: true,
        unitPrice: true,
        originalPrice: true,
        priceType: true,
        boxes: true,
        pieces: true,
        unitsPerBox: true,
        unitLabel: true,
      },
    },
  } as const;
}

/** Credit note fields the attribution rule needs; its lines are mapped by `lineProducts`. */
const CREDIT_NOTE_ATTRIBUTION_SELECT = {
  id: true,
  amount: true,
  status: true,
  createdAt: true,
  customerId: true,
  customer: { select: { businessName: true } },
  items: { select: { invoiceItemId: true, amount: true } },
} as const;

/** Every invoice-line id the notes' items point at. */
const referencedLineIds = (notes: any[]) =>
  [
    ...new Set(
      notes.flatMap((n) =>
        (n.items ?? []).map((it: any) => it.invoiceItemId as string | null).filter(Boolean),
      ),
    ),
  ] as string[];

/** One note → the attribution rule's input shape. */
const noteForAttribution = (n: any) => ({
  amount: Number(n.amount),
  items: (n.items ?? []).map((it: any) => ({
    invoiceItemId: (it.invoiceItemId as string | null) ?? null,
    amount: Number(it.amount),
  })),
});

const epoch = (d: Date | null | undefined) => (d ? d.getTime() : 0);

/** Newest line first inside one invoice: entry time, then id (JS-only order, see paging). */
function byLineDesc(a: any, b: any): number {
  const t = epoch(b.createdAt) - epoch(a.createdAt);
  if (t !== 0) return t;
  const ai = String(a.id ?? "");
  const bi = String(b.id ?? "");
  return ai < bi ? 1 : ai > bi ? -1 : 0;
}

function toSaleFact(inv: any, item: any): ProductSaleFact {
  return {
    lineId: item.id ?? "",
    lineCreatedAt: item.createdAt ?? inv.createdAt ?? inv.issueDate,
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    invoiceStatus: inv.status ?? null,
    issueDate: inv.issueDate,
    invoiceCreatedAt: inv.createdAt ?? inv.issueDate,
    orderId: inv.orderId ?? null,
    orderNumber: inv.order?.orderNumber ?? null,
    customerId: inv.customerId,
    customerName: inv.customer?.businessName ?? null,
    qty: Number(item.qty),
    subtotal: Number(item.subtotal),
    unitPrice: Number(item.unitPrice ?? 0),
    originalPrice: item.originalPrice != null ? Number(item.originalPrice) : null,
    priceType: item.priceType ?? null,
    boxes: item.boxes ?? null,
    pieces: item.pieces ?? null,
    unitsPerBox: item.unitsPerBox ?? null,
    unitLabel: item.unitLabel ?? null,
  };
}

/**
 * Keyset "at or after" a cursor in (issueDate desc, createdAt desc, id desc) order. INCLUSIVE of
 * the cursor's own invoice: a page can end mid-invoice, and that invoice's remaining lines are
 * dropped in code (`productSaleFacts`) by the line half of the key.
 */
function atOrAfter(k: LineKey) {
  return [
    { issueDate: { lt: k.issueDate } },
    { issueDate: k.issueDate, createdAt: { lt: k.invoiceCreatedAt } },
    { issueDate: k.issueDate, createdAt: k.invoiceCreatedAt, id: { lte: k.invoiceId } },
  ];
}

export interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  unitSku: string | null;
  barcode: string | null;
  unitsPerBox: number | null;
  unit: string;
  isActive: boolean;
}

/** Per-line netting facts for a page of sold lines. */
export interface LineNetting {
  /** Σ non-VOID credit-note line items on this line (any date). */
  creditedAmount: number;
  /** Σ pieces of INLINE return lines sourced from this line that have a netting event. */
  returnedQty: number;
}

/**
 * #2118 (plan A1) — the ONE sales-fact reader: invoiced lines on the accrual basis
 * (`ACCRUAL_REVENUE_STATUSES`), credit notes and external refunds on their own dates, all
 * through the shared predicates in `common/invoiced-sales.ts`; `netOf` composes every net.
 * Product (and, next, customer) insights shape what this reads; they never query around it.
 *
 * Reads go THROUGH a parent (`Invoice`, `CreditNote`, `Return`) with an explicit `tenantId` in
 * every where-clause: child rows are nested writes, so a legacy child can carry
 * `tenantId = null` (the trap `invoiced-sales.ts` documents), and a null ambient tenant must
 * fail closed, never read across tenants (B440 finding 2).
 */
@Injectable()
export class SalesFactsService {
  constructor(private readonly prisma: PrismaService) {}

  private db() {
    return this.prisma.forTenant();
  }

  /** The request's tenant; refuses a tenant-less (SUPER_ADMIN) context instead of reading unscoped. */
  requireTenantId(): string {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    return tenantId;
  }

  /**
   * The tenant's configured IANA zone, or null (no `TenantConfig` row) — the calendar helpers
   * then fall back to UTC, never to a guessed zone (the analytics convention).
   */
  async tenantTimezone(tenantId: string): Promise<string | null> {
    const cfg = await this.prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { timezone: true },
    });
    return cfg?.timezone ?? null;
  }

  /** Today's calendar day ("YYYY-MM-DD") in `timeZone` (UTC when null). */
  today(timeZone: string | null, now: Date = new Date()): string {
    return calendarDateFromIso(startOfCalendarDay(now, timeZone));
  }

  /** [fromDay, toDay] as UTC-midnight stamps, half-open — the `issueDate` filter. */
  issueWindow(fromDay: string, toDay: string): InstantWindow {
    return {
      gte: new Date(isoFromCalendarDate(fromDay)),
      lt: new Date(isoFromCalendarDate(addCalendarDays(toDay, 1))),
    };
  }

  /**
   * [fromDay, toDay] as REAL instants in the tenant's zone, half-open — the filter for
   * `CreditNote.createdAt` / `Return.refundedAt` (plan A5): a credit at 23:30 local on the 31st
   * belongs to the 31st.
   */
  instantWindow(fromDay: string, toDay: string, timeZone: string | null): InstantWindow {
    return {
      gte: startOfLocalDay(fromDay, timeZone),
      lt: startOfLocalDay(addCalendarDays(toDay, 1), timeZone),
    };
  }

  /** The product row insights label with; a deactivated product stays reachable by id. */
  async product(tenantId: string, productId: string): Promise<ProductRow | null> {
    return this.db().product.findFirst({
      where: { id: productId, tenantId },
      select: {
        id: true,
        name: true,
        sku: true,
        unitSku: true,
        barcode: true,
        unitsPerBox: true,
        unit: true,
        isActive: true,
      },
    });
  }

  /**
   * One product's sold lines on the accrual basis, newest first: issue date, invoice entry and
   * id (from the DB), then line entry and id inside each invoice (in code). `after` continues a
   * page: the DB keyset keeps the cursor's invoice, whose already-served lines are dropped here
   * by the line half of the key. `take` counts INVOICES (each has ≥ 1 line of the product), so
   * `take = limit + 2` always yields `limit + 1` lines when that many remain.
   */
  async productSaleFacts(
    tenantId: string,
    productId: string,
    opts: {
      issueWindow?: InstantWindow;
      customerId?: string;
      after?: LineKey;
      take?: number;
      /** Default true: read each invoice's order number. */
      orderNumber?: boolean;
      /** Default true: read each invoice's customer name. */
      customerName?: boolean;
    } = {},
  ): Promise<ProductSaleFact[]> {
    const invoices = await this.db().invoice.findMany({
      where: {
        tenantId,
        status: ACCRUAL_STATUS_FILTER,
        items: { some: { productId } },
        ...(opts.issueWindow ? { issueDate: opts.issueWindow } : {}),
        ...(opts.customerId ? { customerId: opts.customerId } : {}),
        ...(opts.after
          ? {
              OR: atOrAfter(opts.after),
              // Implied by the OR, stated so Postgres can START the index range at the cursor
              // (an OR is only a filter): a deep page never re-reads every earlier row.
              AND: [{ issueDate: { lte: opts.after.issueDate } }],
            }
          : {}),
      },
      select: saleFactSelect(productId, {
        orderNumber: opts.orderNumber ?? true,
        customerName: opts.customerName ?? true,
      }),
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      ...(opts.take ? { take: opts.take } : {}),
    });

    const after = opts.after;
    const facts: ProductSaleFact[] = [];
    for (const inv of invoices as any[]) {
      for (const item of [...(inv.items ?? [])].sort(byLineDesc)) {
        const fact = toSaleFact(inv, item);
        // Only the cursor's own invoice can hold already-served lines; comparing inside ONE
        // invoice never depends on the DB's text collation agreeing with JS.
        if (
          after &&
          fact.invoiceId === after.invoiceId &&
          compareLineKeysDesc(lineKeyOf(fact), after) <= 0
        ) {
          continue;
        }
        facts.push(fact);
      }
    }
    return facts;
  }

  /**
   * invoice-line id → productId (null for an unlisted line) for the given line ids, read
   * THROUGH their invoices. A credit note item's `invoiceItemId` is a plain id (no relation);
   * an id that no longer exists (a delivered-basis reconcile rotates line ids) is simply
   * absent, which the attribution rule treats as unattributed.
   */
  async lineProducts(tenantId: string, lineIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const ids = [...new Set(lineIds.filter(Boolean))];
    for (let i = 0; i < ids.length; i += LINE_ID_CHUNK) {
      const chunk = ids.slice(i, i + LINE_ID_CHUNK);
      // eslint-disable-next-line no-await-in-loop
      const invoices = await this.db().invoice.findMany({
        where: { tenantId, items: { some: { id: { in: chunk } } } },
        select: { items: { where: { id: { in: chunk } }, select: { id: true, productId: true } } },
      });
      for (const inv of invoices as any[]) {
        for (const it of inv.items ?? []) out.set(it.id, it.productId ?? null);
      }
    }
    return out;
  }

  /**
   * Accrual sales of MANY products in one window, one grouped read (a catalog export's stats
   * columns). Same status filter, tenant scope and pieces rule (`salePiecesOf`) as
   * `productSaleFacts`; nothing here reads an order or any payment status. `packNow` is the
   * gate for a snapshot-less line (the live product pack, never a multiplier).
   */
  async periodProductStats(
    tenantId: string,
    productIds: string[],
    issueWindow: InstantWindow,
    packNow: Map<string, number | null>,
  ): Promise<Map<string, ProductPeriodStats>> {
    const out = new Map<string, ProductPeriodStats>();
    if (productIds.length === 0) return out;
    const items = await this.db().invoiceItem.findMany({
      where: {
        productId: { in: productIds },
        invoice: { tenantId, status: ACCRUAL_STATUS_FILTER, issueDate: issueWindow },
      },
      select: {
        productId: true,
        qty: true,
        subtotal: true,
        boxes: true,
        pieces: true,
        unitsPerBox: true,
        invoice: { select: { issueDate: true } },
      },
    });
    for (const it of items as any[]) {
      const id = it.productId as string;
      const acc = out.get(id) ?? { pieces: 0, gross: 0, lastSold: null };
      acc.pieces += salePiecesOf({ ...it, qty: Number(it.qty) }, packNow.get(id) ?? null) ?? 0;
      acc.gross += Number(it.subtotal);
      const at = it.invoice?.issueDate as Date | undefined;
      if (at && (!acc.lastSold || at > acc.lastSold)) acc.lastSold = at;
      out.set(id, acc);
    }
    return out;
  }

  /** Lifetime first / most recent sale stamps (accrual basis) — "never sold" vs "quiet window". */
  async productLifetime(tenantId: string, productId: string): Promise<ProductLifetime> {
    const where = { tenantId, status: ACCRUAL_STATUS_FILTER, items: { some: { productId } } };
    const db = this.db();
    const [first, last] = await Promise.all([
      db.invoice.findFirst({ where, orderBy: { issueDate: "asc" }, select: { issueDate: true } }),
      db.invoice.findFirst({ where, orderBy: { issueDate: "desc" }, select: { issueDate: true } }),
    ]);
    return { first: first?.issueDate ?? null, last: last?.issueDate ?? null };
  }

  /**
   * The credits and returns TOUCHING one product in an instant window (plan A3):
   * - attributed: credit-note line items on the product's lines (dated by the note's
   *   `createdAt`) and INLINE external-refund line subtotals (dated by `refundedAt`);
   * - returned: the product's return quantities, dated by the SAME event their money nets on
   *   (`returnNettingDate`) — the aggregator windows them by day;
   * - unattributed: what no stored line fact attributes — a header-only or partly itemized note
   *   on an invoice carrying the product, a note minted for a return of it, a STANDARD external
   *   refund of it, the tax part of an INLINE one.
   * Every read is bounded by the window: a return is read only when its external refund
   * (`refundedAt`) or its credit note (`createdAt`) falls in it — never all-time.
   * Round trips: notes + the ids of credit-note returns; returns; then the notes those returns
   * point at + the products of the lines the notes itemize; then (rarely) the lines itemized
   * on those return-linked notes.
   */
  async productCreditEvents(
    tenantId: string,
    productId: string,
    window: InstantWindow,
  ): Promise<ProductCreditEvents> {
    const db = this.db();
    const [notes, creditNoteReturnIds] = await Promise.all([
      db.creditNote.findMany({
        where: {
          tenantId,
          ...ACCRUAL_CREDIT_NOTE_FILTER,
          createdAt: window,
          invoice: { is: { items: { some: { productId } } } },
        },
        select: CREDIT_NOTE_ATTRIBUTION_SELECT,
      }),
      this.creditNoteReturnIds(tenantId, productId, window),
    ]);
    const returns = await db.return.findMany({
      where: {
        tenantId,
        items: { some: { productId } },
        OR: [
          // The Return term: an external refund in the window.
          { ...EXTERNAL_REFUND_FILTER, refundedAt: window },
          // The CreditNote term: returns whose credit note was created in the window.
          ...(creditNoteReturnIds.length ? [{ id: { in: creditNoteReturnIds } }] : []),
        ],
      },
      select: {
        id: true,
        kind: true,
        orderId: true,
        refundMethod: true,
        refundAmount: true,
        refundedAt: true,
        creditNoteId: true,
        customerId: true,
        customer: { select: { businessName: true } },
        items: { select: { productId: true, qty: true, subtotal: true } },
      },
    });

    const noteIds = new Set((notes as any[]).map((n) => n.id));
    const missing = [
      ...new Set(
        (returns as any[])
          .map((r) => r.creditNoteId as string | null)
          .filter((id): id is string => !!id && !noteIds.has(id)),
      ),
    ];
    const [returnNotes, lineProduct] = await Promise.all([
      missing.length
        ? db.creditNote.findMany({
            where: { tenantId, ...ACCRUAL_CREDIT_NOTE_FILTER, id: { in: missing } },
            select: CREDIT_NOTE_ATTRIBUTION_SELECT,
          })
        : Promise.resolve([]),
      this.lineProducts(tenantId, referencedLineIds(notes as any[])),
    ]);
    const unmapped = referencedLineIds(returnNotes as any[]).filter((id) => !lineProduct.has(id));
    if (unmapped.length) {
      for (const [id, product] of await this.lineProducts(tenantId, unmapped)) {
        lineProduct.set(id, product);
      }
    }

    const inWindow = (at: Date | null | undefined) =>
      !!at && at.getTime() >= window.gte.getTime() && at.getTime() < window.lt.getTime();
    const notesById = new Map<string, any>();
    for (const n of [...(notes as any[]), ...(returnNotes as any[])]) notesById.set(n.id, n);

    const attributed: AttributedCreditEvent[] = [];
    const unattributed: UnattributedCreditEvent[] = [];
    const returned: ReturnedQtyEvent[] = [];

    // Every touching note counts ONCE, whichever read found it (the CreditNote term). Both note
    // reads apply ACCRUAL_CREDIT_NOTE_FILTER, so a VOID note is never here (L-167: the status
    // rule lives in that one predicate). Its items on OTHER products' lines and on unlisted
    // lines are attributed there — only the amount-only part (and an item whose line id no
    // longer exists) is this product's footnote (SA-289).
    for (const n of notesById.values()) {
      if (!inWindow(n.createdAt)) continue;
      const split = attributeCreditNote(noteForAttribution(n), lineProduct);
      const mine = split.byProduct.get(productId);
      if (mine) {
        attributed.push({
          at: n.createdAt,
          amount: mine,
          kind: "CREDIT_NOTE",
          customerId: n.customerId,
          customerName: n.customer?.businessName ?? null,
        });
      }
      if (split.unattributed !== 0)
        unattributed.push({ at: n.createdAt, amount: split.unattributed });
    }

    const noteDates = new Map<string, { createdAt: Date }>();
    for (const n of notesById.values()) noteDates.set(n.id, { createdAt: n.createdAt });

    for (const r of returns as any[]) {
      const customerName = r.customer?.businessName ?? null;
      // The Return term: an external refund in the window.
      if (r.refundMethod === "EXTERNAL_REFUND" && inWindow(r.refundedAt)) {
        const split = attributeExternalRefund({
          kind: r.kind,
          refundAmount: Number(r.refundAmount ?? 0),
          items: (r.items ?? []).map((it: any) => ({
            productId: it.productId ?? null,
            subtotal: it.subtotal != null ? Number(it.subtotal) : null,
          })),
        });
        const mine = split.byProduct.get(productId);
        if (mine) {
          attributed.push({
            at: r.refundedAt,
            amount: mine,
            kind: "EXTERNAL_REFUND",
            customerId: r.customerId,
            customerName,
          });
        }
        if (split.unattributed !== 0) {
          unattributed.push({ at: r.refundedAt, amount: split.unattributed });
        }
      }
    }

    // Returned pieces, netted on the same event as the return's money (B440 terms). An INLINE
    // return line stores genuine pieces; a STANDARD one is typed in the order line's own unit
    // (B665), so it converts through the ONE sanctioned resolver — never a guessed pack.
    const pending: Promise<void>[] = [];
    const resolvers = new Map<string, ReturnType<typeof standardRestockResolver>>();
    for (const r of returns as any[]) {
      const at = returnNettingDate(
        {
          refundMethod: r.refundMethod ?? null,
          refundedAt: r.refundedAt ?? null,
          creditNoteId: r.creditNoteId ?? null,
        },
        noteDates,
      );
      if (!at || !inWindow(at)) continue;
      const customerName = r.customer?.businessName ?? null;
      for (const it of (r.items ?? []).filter((x: any) => x.productId === productId)) {
        if (r.kind === "INLINE") {
          returned.push({
            at,
            qty: roundQty(Number(it.qty)),
            customerId: r.customerId,
            customerName,
          });
          continue;
        }
        // The raw client, on purpose: the resolver filters by this (tenant-owned) return's
        // order id and that order's line ids, and a tenant-injected where would drop legacy
        // null-tenant order lines — the nested-write trap this layer reads around.
        let resolve = resolvers.get(r.orderId);
        if (!resolve) {
          resolve = standardRestockResolver(this.prisma, r.orderId);
          resolvers.set(r.orderId, resolve);
        }
        const run = resolve;
        pending.push(
          run({ productId: it.productId, qty: it.qty, restock: true }).then((res) => {
            returned.push({
              at,
              qty: "unknown" in res ? null : roundQty(res.pieces),
              customerId: r.customerId,
              customerName,
            });
          }),
        );
      }
    }
    await Promise.all(pending);

    return { attributed, returned, unattributed };
  }

  /**
   * Ids of this product's returns whose credit note was CREATED in the window — the only
   * credit-note returns whose quantity or money can net in it (`returnNettingDate`). A bounded
   * join on `CreditNote(tenantId, createdAt)`; raw because `Return.creditNoteId` has no Prisma
   * relation. It narrows by date ONLY: a VOID note is dropped by the note reads, which apply
   * ACCRUAL_CREDIT_NOTE_FILTER, so the status rule stays in one place (L-167).
   */
  private async creditNoteReturnIds(
    tenantId: string,
    productId: string,
    window: InstantWindow,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT r."id"
      FROM "Return" r
      JOIN "CreditNote" cn ON cn."id" = r."creditNoteId"
      WHERE r."tenantId" = ${tenantId}
        AND cn."tenantId" = ${tenantId}
        AND cn."createdAt" >= ${window.gte}
        AND cn."createdAt" < ${window.lt}
        AND EXISTS (
          SELECT 1 FROM "ReturnItem" ri WHERE ri."returnId" = r."id" AND ri."productId" = ${productId}
        )`;
    return (rows ?? []).map((r) => r.id);
  }

  /**
   * Netting facts for a page of lines (credited amount, returned pieces), keyed by line id.
   * Credit-note line items are the only stored per-line credit; returned pieces are exact only
   * for INLINE returns, which record their source line (`ReturnItem.sourceInvoiceItemId`).
   */
  async lineNetting(tenantId: string, lineIds: string[]): Promise<Map<string, LineNetting>> {
    const out = new Map<string, LineNetting>();
    const ids = [...new Set(lineIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const db = this.db();
    const [notes, returns] = await Promise.all([
      db.creditNote.findMany({
        where: {
          tenantId,
          ...ACCRUAL_CREDIT_NOTE_FILTER,
          items: { some: { invoiceItemId: { in: ids } } },
        },
        select: {
          items: {
            where: { invoiceItemId: { in: ids } },
            select: { invoiceItemId: true, amount: true },
          },
        },
      }),
      db.return.findMany({
        where: { tenantId, items: { some: { sourceInvoiceItemId: { in: ids } } } },
        select: {
          refundMethod: true,
          refundedAt: true,
          creditNoteId: true,
          items: {
            where: { sourceInvoiceItemId: { in: ids } },
            select: { sourceInvoiceItemId: true, qty: true },
          },
        },
      }),
    ]);
    const noteIds = [
      ...new Set((returns as any[]).map((r) => r.creditNoteId).filter((id): id is string => !!id)),
    ];
    const returnNotes = noteIds.length
      ? await db.creditNote.findMany({
          where: { tenantId, ...ACCRUAL_CREDIT_NOTE_FILTER, id: { in: noteIds } },
          select: { id: true, createdAt: true },
        })
      : [];
    const noteDates = new Map<string, { createdAt: Date }>(
      (returnNotes as any[]).map((n) => [n.id, { createdAt: n.createdAt }]),
    );

    const credited = new Map<string, number>();
    for (const n of notes as any[]) {
      for (const it of n.items ?? []) {
        credited.set(it.invoiceItemId, (credited.get(it.invoiceItemId) ?? 0) + Number(it.amount));
      }
    }
    const returnedQty = new Map<string, number>();
    for (const r of returns as any[]) {
      const at = returnNettingDate(
        {
          refundMethod: r.refundMethod ?? null,
          refundedAt: r.refundedAt ?? null,
          creditNoteId: r.creditNoteId ?? null,
        },
        noteDates,
      );
      if (!at) continue;
      for (const it of r.items ?? []) {
        const k = it.sourceInvoiceItemId;
        returnedQty.set(k, (returnedQty.get(k) ?? 0) + Number(it.qty));
      }
    }
    for (const id of ids) {
      out.set(id, {
        creditedAmount: roundMoney(credited.get(id) ?? 0),
        returnedQty: roundQty(returnedQty.get(id) ?? 0),
      });
    }
    return out;
  }

  // ─── Tenant-level reconciliation (plan §E identities) ─────────────────────

  /**
   * Accrual gross of a tenant-window split the way product insights see it: by product
   * (listed lines), unlisted lines, shipping and header discount. The identity
   * `Σ byProduct + unlisted + shipping − headerDiscount = gross` holds whenever each invoice's
   * `subtotal` equals the sum of its lines (the invoice writers' invariant).
   */
  async tenantGrossBreakdown(
    tenantId: string,
    issueWindow: InstantWindow,
  ): Promise<{
    gross: number;
    byProduct: Map<string, number>;
    unlisted: number;
    shipping: number;
    headerDiscount: number;
  }> {
    const invoices = await this.db().invoice.findMany({
      where: { tenantId, status: ACCRUAL_STATUS_FILTER, issueDate: issueWindow },
      select: {
        total: true,
        taxAmount: true,
        discount: true,
        shippingFee: true,
        items: { select: { productId: true, subtotal: true } },
      },
    });
    let gross = 0;
    let unlisted = 0;
    let shipping = 0;
    let headerDiscount = 0;
    const raw = new Map<string, number>();
    for (const inv of invoices as any[]) {
      gross += Number(inv.total) - Number(inv.taxAmount ?? 0);
      shipping += Number(inv.shippingFee ?? 0);
      headerDiscount += Number(inv.discount ?? 0);
      for (const it of inv.items ?? []) {
        if (it.productId) raw.set(it.productId, (raw.get(it.productId) ?? 0) + Number(it.subtotal));
        else unlisted += Number(it.subtotal);
      }
    }
    const byProduct = new Map<string, number>();
    for (const [k, v] of raw) byProduct.set(k, roundMoney(v));
    return {
      gross: roundMoney(gross),
      byProduct,
      unlisted: roundMoney(unlisted),
      shipping: roundMoney(shipping),
      headerDiscount: roundMoney(headerDiscount),
    };
  }

  /**
   * Every credit of a tenant-window split by the attribution rules: per product, on unlisted
   * lines, and the unattributed rest. `Σ byProduct + unlisted + unattributed = creditNotes +
   * externalRefunds` exactly — each note's and refund's parts sum to its own amount.
   */
  async tenantCreditBreakdown(
    tenantId: string,
    window: InstantWindow,
  ): Promise<{
    byProduct: Map<string, number>;
    unlisted: number;
    unattributed: number;
    creditNotes: number;
    externalRefunds: number;
  }> {
    const db = this.db();
    const [notes, refunds] = await Promise.all([
      db.creditNote.findMany({
        where: { tenantId, ...ACCRUAL_CREDIT_NOTE_FILTER, createdAt: window },
        select: CREDIT_NOTE_ATTRIBUTION_SELECT,
      }),
      db.return.findMany({
        where: { tenantId, ...EXTERNAL_REFUND_FILTER, refundedAt: window },
        select: {
          kind: true,
          refundAmount: true,
          items: { select: { productId: true, subtotal: true } },
        },
      }),
    ]);
    const lineProduct = await this.lineProducts(tenantId, referencedLineIds(notes as any[]));
    const raw = new Map<string, number>();
    let unlisted = 0;
    let unattributed = 0;
    let creditNotes = 0;
    let externalRefunds = 0;
    const add = (byProduct: Map<string, number>) => {
      for (const [k, v] of byProduct) raw.set(k, (raw.get(k) ?? 0) + v);
    };
    for (const n of notes as any[]) {
      creditNotes += Number(n.amount);
      const split = attributeCreditNote(noteForAttribution(n), lineProduct);
      add(split.byProduct);
      unlisted += split.unlisted;
      unattributed += split.unattributed;
    }
    for (const r of refunds as any[]) {
      externalRefunds += Number(r.refundAmount ?? 0);
      const split = attributeExternalRefund({
        kind: r.kind,
        refundAmount: Number(r.refundAmount ?? 0),
        items: (r.items ?? []).map((it: any) => ({
          productId: it.productId ?? null,
          subtotal: it.subtotal != null ? Number(it.subtotal) : null,
        })),
      });
      add(split.byProduct);
      unattributed += split.unattributed;
    }
    const byProduct = new Map<string, number>();
    for (const [k, v] of raw) byProduct.set(k, roundMoney(v));
    return {
      byProduct,
      unlisted: roundMoney(unlisted),
      unattributed: roundMoney(unattributed),
      creditNotes: roundMoney(creditNotes),
      externalRefunds: roundMoney(externalRefunds),
    };
  }
}
