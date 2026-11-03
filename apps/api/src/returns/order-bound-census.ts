/**
 * SA-1091 piece 1 (row 631): READ-ONLY census of the OLD rows, ported to the helper's terms (an owner-run report; it never
 * feeds a figure and never changes a row). The order-wide bound (`loadOrderRefundRoom`) starts refusing a take past the room;
 * what was given back before it existed stays as it is. This counts how much of that there is:
 *
 *   orders.overBound   orders whose room is already below zero, read by `loadOrderRefundRooms` (the bound's own arithmetic,
 *                      `composeOrderRefundRoom`, which a real-Postgres spec holds equal to the live helper): their LATER
 *                      credits are refused, nothing else changes. A remedy is the owner's call.
 *   inline.*           the second count SA-1091 owes: invoices whose STORED inline gross (net + tax + category tax of the live
 *                      inline return rows sourced from their lines) passes what the invoice CHARGED for those lines, priced by
 *                      `refundableLineShare` for the whole line with no prior. Per invoice (sums) and per line. "Reopen the
 *                      A-1 repricing only if this count isn't small."
 *
 * COUNTS ONLY: no tenant, customer, order, invoice or amount is returned; the over amounts are bucketed (a cent, up to a
 * dollar, more). `apps/api/scripts/report-sa1091-order-bound-census.mjs` is the thin runner (read-only session, ROLLBACK).
 *
 * SHAPE (the first production run held ONE transaction for 120 s and timed out): every read goes through `read`, a short
 * read-only transaction the runner proves read-only and rolls back each time. Discovery is keyed pages (by id); the bound is
 * read for a batch of anchors at once instead of about eight reads per order (107,785 reads for 13,456 orders on a 30k-sale
 * local seed); long phases are cut into slices so no transaction stays open past `sliceMs`; a deadline stops new reads.
 */
import { refundableInvoiceOf, refundableLineShare, roundMoney } from "@routeflow/pricing";
import { loadOrderRefundRooms } from "../credit-notes/line-credit-headroom";
import { CREDIT_SOURCE_EXCLUDED } from "../invoices/invoice-status-sets";

/** The same two statuses `loadOrderRefundRoom` leaves out of an inline return's gross. */
const DEAD_RETURN = ["CANCELLED", "REJECTED"];
/** Half a cent: stored money is whole cents, so anything past this is at least one cent. */
const EPS = 0.005;
/** ids per keyed `in` read */
const BATCH = 500;

export interface OverBuckets {
  /** over by exactly a cent (or less than 1.5 cents) */
  upToOneCent: number;
  /** over by more than a cent, up to a dollar */
  upToOneDollar: number;
  /** over by more than a dollar */
  overOneDollar: number;
}

export interface OrderBoundCensus {
  orders: {
    /** anchors read: an order (or an order-less invoice) that gave something back */
    scanned: number;
    /** scanned anchors with no creditable invoice, so no bound (the helper returns null) */
    noBound: number;
    overBound: number;
    overBy: OverBuckets;
    /** of the over-bound anchors, how many have each giver above zero (one anchor can count in several) */
    overBoundGivers: { notes: number; unlinked: number; recorded: number; inline: number };
  };
  inline: {
    /** invoices with at least one live inline return row sourced from a line (not void / written off) */
    invoicesWithInline: number;
    /** invoices whose Σ stored inline gross passes Σ what their lines charged */
    invoicesPastCharge: number;
    invoicesPastBy: OverBuckets;
    /** invoice lines whose stored inline gross passes the line's charge */
    linesPastCharge: number;
    /** invoices the helper could not read (a bad stored pool): counted, never guessed */
    invoicesUnreadable: number;
  };
  /** plain counts that prove the database is live: all 0 = the run proved nothing */
  denominators: {
    creditableInvoicesWithLiveNotes: number;
    liveInlineReturnItems: number;
    liveStandardReturnOrders: number;
  };
}

const zeroBuckets = (): OverBuckets => ({ upToOneCent: 0, upToOneDollar: 0, overOneDollar: 0 });

function bucket(into: OverBuckets, over: number) {
  if (over <= 0.015) into.upToOneCent += 1;
  else if (over <= 1) into.upToOneDollar += 1;
  else into.overOneDollar += 1;
}

const chunks = <T>(xs: readonly T[], n = BATCH): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const grossOf = (it: { subtotal: unknown; taxAmount: unknown; categoryTax: unknown }) =>
  Number(it.subtotal ?? 0) + Number(it.taxAmount ?? 0) + Number(it.categoryTax ?? 0);

/** One short read-only unit: runs `fn` on a read-only transaction client and always ends it with a ROLLBACK. */
export type Reader = <T>(fn: (tx: any) => Promise<T>) => Promise<T>;

export interface CensusOptions {
  /** narrows every read to one tenant (specs) */
  tenantId?: string;
  /** rows per keyed page of a discovery read (default 2000) */
  pageSize?: number;
  /** anchors read together by `loadOrderRefundRooms` (default 150) */
  anchorBatch?: number;
  /** a read-only transaction is closed and a new one opened once it has run this long (default 15 s) */
  sliceMs?: number;
  /** transactions open at once (default 1): this is how many connections the run holds */
  workers?: number;
  /** epoch ms after which no new read starts; the run then throws exit code 3 (default: none) */
  deadline?: number;
  now?: () => number;
  /** phase name and counts only, never a row */
  onProgress?: (p: { phase: string; done: number; total: number | null }) => void;
}

/** Thrown when the time budget runs out between two reads: nothing is half-counted, the run reports no numbers. */
export class CensusBudgetExceeded extends Error {
  exitCode = 3;
  constructor(phase: string) {
    super(`census: the time budget ran out during "${phase}"; no counts were produced`);
  }
}

/** Plain reads only (findMany). Every read goes through `read`; see the SHAPE note in the header. */
export async function censusOrderBound(
  read: Reader,
  opts: CensusOptions = {},
): Promise<OrderBoundCensus> {
  const tenantWhere = opts.tenantId ? { tenantId: opts.tenantId } : {};
  const pageSize = opts.pageSize ?? 2000;
  const anchorBatch = opts.anchorBatch ?? 150;
  const sliceMs = opts.sliceMs ?? 15_000;
  const workers = Math.max(1, opts.workers ?? 1);
  const now = opts.now ?? Date.now;
  let phase = "start";
  const alive = () => {
    if (opts.deadline !== undefined && now() >= opts.deadline)
      throw new CensusBudgetExceeded(phase);
  };
  const progress = (done: number, total: number | null) =>
    opts.onProgress?.({ phase, done, total });

  /** Keyed pages by id, each page its own read; `take` returns the page's rows (with `id`), `use` consumes them. */
  async function paged<R extends { id: string }>(
    name: string,
    take: (tx: any, afterId: string | undefined) => Promise<R[]>,
    use: (rows: R[]) => void,
  ) {
    phase = name;
    let after: string | undefined;
    let done = 0;
    for (;;) {
      alive();
      const rows = await read((tx) => take(tx, after));
      use(rows);
      done += rows.length;
      progress(done, null);
      if (rows.length < pageSize) return;
      after = rows[rows.length - 1].id;
    }
  }

  /** `items` in order, each handled inside a read that is closed once it has run `sliceMs`; `workers` reads at a time. */
  async function sliced<T>(
    name: string,
    items: readonly T[],
    fn: (tx: any, item: T) => Promise<void>,
  ) {
    phase = name;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < items.length) {
        alive();
        await read(async (tx) => {
          const t0 = now();
          // at least one item per read, so a zero slice still moves forward
          do {
            if (next >= items.length) return;
            const item = items[next++];
            await fn(tx, item);
            done += 1;
            progress(done, items.length);
          } while (now() - t0 < sliceMs);
        });
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
  }

  const result: OrderBoundCensus = {
    orders: {
      scanned: 0,
      noBound: 0,
      overBound: 0,
      overBy: zeroBuckets(),
      overBoundGivers: { notes: 0, unlinked: 0, recorded: 0, inline: 0 },
    },
    inline: {
      invoicesWithInline: 0,
      invoicesPastCharge: 0,
      invoicesPastBy: zeroBuckets(),
      linesPastCharge: 0,
      invoicesUnreadable: 0,
    },
    denominators: {
      creditableInvoicesWithLiveNotes: 0,
      liveInlineReturnItems: 0,
      liveStandardReturnOrders: 0,
    },
  };

  // 1. The live inline rows that name a source line, and the invoice each line sits on
  const storedByLine = new Map<string, number>();
  await paged<{
    id: string;
    subtotal: unknown;
    taxAmount: unknown;
    categoryTax: unknown;
    sourceInvoiceItemId: string;
  }>(
    "inline return rows",
    (tx, after) =>
      tx.returnItem.findMany({
        where: {
          ...tenantWhere,
          ...(after ? { id: { gt: after } } : {}),
          sourceInvoiceItemId: { not: null },
          return: { kind: "INLINE", status: { notIn: DEAD_RETURN } },
        },
        select: {
          id: true,
          subtotal: true,
          taxAmount: true,
          categoryTax: true,
          sourceInvoiceItemId: true,
        },
        orderBy: { id: "asc" },
        take: pageSize,
      }),
    (rows) => {
      result.denominators.liveInlineReturnItems += rows.length;
      for (const it of rows)
        storedByLine.set(
          it.sourceInvoiceItemId,
          roundMoney((storedByLine.get(it.sourceInvoiceItemId) ?? 0) + grossOf(it)),
        );
    },
  );
  const invoiceOfLine = new Map<string, string>();
  const anchors = new Map<string, { orderId?: string; invoiceId?: string }>();
  const anchorOf = (inv: { id: string; orderId: string | null }) =>
    anchors.set(inv.orderId ? `o:${inv.orderId}` : `i:${inv.id}`, {
      ...(inv.orderId ? { orderId: inv.orderId } : { invoiceId: inv.id }),
    });
  await sliced("inline source lines", chunks([...storedByLine.keys()]), async (tx, ids) => {
    const lines: Array<{ id: string; invoiceId: string; invoice: any }> =
      await tx.invoiceItem.findMany({
        where: {
          id: { in: ids },
          ...tenantWhere,
          invoice: { status: { notIn: CREDIT_SOURCE_EXCLUDED } },
        },
        select: { id: true, invoiceId: true, invoice: { select: { id: true, orderId: true } } },
      });
    for (const l of lines) {
      invoiceOfLine.set(l.id, l.invoiceId);
      anchorOf(l.invoice);
    }
  });

  // 2. Every creditable invoice with a live credit note, and every order with a live standard return
  await paged<{ id: string; orderId: string | null }>(
    "invoices with credit notes",
    (tx, after) =>
      tx.invoice.findMany({
        where: {
          ...tenantWhere,
          ...(after ? { id: { gt: after } } : {}),
          status: { notIn: CREDIT_SOURCE_EXCLUDED },
          // scan-ok: draft-payment-not-void — a credit NOTE status (VOID notes are not refunds), not an InvoicePayment status
          creditNotes: { some: { status: { not: "VOID" } } },
        },
        select: { id: true, orderId: true },
        orderBy: { id: "asc" },
        take: pageSize,
      }),
    (rows) => {
      result.denominators.creditableInvoicesWithLiveNotes += rows.length;
      for (const inv of rows) anchorOf(inv);
    },
  );
  const standardOrders = new Set<string>();
  await paged<{ id: string; orderId: string }>(
    "standard returns",
    (tx, after) =>
      tx.return.findMany({
        where: {
          ...tenantWhere,
          ...(after ? { id: { gt: after } } : {}),
          kind: { not: "INLINE" },
          status: { notIn: DEAD_RETURN },
        },
        select: { id: true, orderId: true },
        orderBy: { id: "asc" },
        take: pageSize,
      }),
    (rows) => {
      for (const r of rows) standardOrders.add(r.orderId);
    },
  );
  result.denominators.liveStandardReturnOrders = standardOrders.size;
  for (const orderId of standardOrders) anchors.set(`o:${orderId}`, { orderId });

  // 3. The order-wide bound: one set of keyed reads per batch of anchors, the figure made by the helper's own arithmetic
  await sliced(
    "order-wide bound",
    chunks([...anchors.values()], anchorBatch),
    async (tx, batch) => {
      const rooms = await loadOrderRefundRooms(tx, batch);
      for (const room of rooms) {
        result.orders.scanned += 1;
        if (!room) {
          result.orders.noBound += 1;
          continue;
        }
        if (room.room >= -EPS) continue;
        result.orders.overBound += 1;
        bucket(result.orders.overBy, roundMoney(-room.room));
        for (const g of ["notes", "unlinked", "recorded", "inline"] as const)
          if (room.given[g] > EPS) result.orders.overBoundGivers[g] += 1;
      }
    },
  );

  // 4. Stored inline gross against what each invoice charged for those lines
  const storedByInvoice = new Map<string, Map<string, number>>();
  for (const [lineId, stored] of storedByLine) {
    const invoiceId = invoiceOfLine.get(lineId);
    if (!invoiceId) continue; // a line on a void / written-off invoice, or gone
    if (!storedByInvoice.has(invoiceId)) storedByInvoice.set(invoiceId, new Map());
    storedByInvoice.get(invoiceId)!.set(lineId, stored);
  }
  result.inline.invoicesWithInline = storedByInvoice.size;
  await sliced(
    "inline against charge",
    chunks([...storedByInvoice.keys()], 100),
    async (tx, ids) => {
      const invoices: any[] = await tx.invoice.findMany({
        where: { id: { in: ids } },
        include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
      });
      for (const inv of invoices) {
        const stored = storedByInvoice.get(inv.id)!;
        try {
          const view = refundableInvoiceOf(inv);
          let chargeSum = 0;
          let storedSum = 0;
          for (const [lineId, storedGross] of stored) {
            const line = view.lines.find((l) => l.id === lineId);
            if (!line || line.isNsf) {
              storedSum = roundMoney(storedSum + storedGross);
              continue; // not goods: nothing charged for it as goods, so all of it is past
            }
            const charge = refundableLineShare({
              invoice: view,
              lineId,
              returnedQty: Number(line.qty),
              prior: { qty: 0, net: 0, tax: 0, categoryTax: 0 },
            });
            chargeSum = roundMoney(chargeSum + charge.total);
            storedSum = roundMoney(storedSum + storedGross);
            if (storedGross > charge.total + EPS) result.inline.linesPastCharge += 1;
          }
          if (storedSum > chargeSum + EPS) {
            result.inline.invoicesPastCharge += 1;
            bucket(result.inline.invoicesPastBy, roundMoney(storedSum - chargeSum));
          }
        } catch {
          result.inline.invoicesUnreadable += 1;
        }
      }
    },
  );
  return result;
}
