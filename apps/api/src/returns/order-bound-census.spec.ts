/**
 * SA-1091 piece 1: the SHAPE of the census (no database). The first production run held one 120 s transaction and timed out,
 * after about eight reads per order; these rows pin what replaced it, against a fake client and a fake clock:
 *
 *   SH-1  discovery is keyed pages: each page is its own read and starts after the last id of the one before
 *   SH-2  the order-wide bound is read for a batch of anchors at once, never one call per anchor
 *   SH-3  a long phase is cut into slices: no read stays open past the slice (plus the one item that crossed it)
 *   SH-4  a zero slice still moves forward (one item per read)
 *   SH-5  at most `workers` reads are open at once
 *   SH-6  past the deadline no new read starts, the run throws exit code 3 and names the phase
 *   SH-7  the numbers do not depend on page size, batch size or slice
 */
import { CensusBudgetExceeded, censusOrderBound, type Reader } from "./order-bound-census";
import { loadOrderRefundRooms } from "../credit-notes/line-credit-headroom";

jest.mock("../credit-notes/line-credit-headroom", () => ({
  loadOrderRefundRooms: jest.fn(),
}));
const rooms = loadOrderRefundRooms as jest.Mock;

const idOf = (n: number) => `id-${String(n).padStart(5, "0")}`;

interface World {
  inlineItems: number; // live inline return rows, each on its own line and invoice
  standardOrders: number; // live standard returns, one per order
}

function fake(world: World, tickPerQuery = 0) {
  const clock = { t: 1_000_000 };
  const log = {
    reads: 0,
    open: 0,
    maxOpen: 0,
    pages: [] as Array<{ model: string; after: string | undefined; take: number }>,
    queriesPerRead: [] as number[],
  };
  const items = Array.from({ length: world.inlineItems }, (_, i) => ({
    id: idOf(i),
    subtotal: 10,
    taxAmount: 1,
    categoryTax: 0,
    sourceInvoiceItemId: `line-${i}`,
  }));
  const standard = Array.from({ length: world.standardOrders }, (_, i) => ({
    id: idOf(i),
    orderId: `order-${i}`,
  }));
  const page = (rows: Array<{ id: string }>, w: any, take: number, model: string) => {
    const after = w.id?.gt as string | undefined;
    log.pages.push({ model, after, take });
    return rows.filter((r) => !after || r.id > after).slice(0, take);
  };
  let queries = 0;
  const tick = async () => {
    queries += 1;
    clock.t += tickPerQuery;
    await Promise.resolve();
  };
  const tx = {
    returnItem: {
      findMany: async (a: any) => {
        await tick();
        return page(items, a.where, a.take, "returnItem");
      },
    },
    invoiceItem: {
      findMany: async (a: any) => {
        await tick();
        return (a.where.id.in as string[]).map((lineId) => ({
          id: lineId,
          invoiceId: `inv-${lineId}`,
          invoice: { id: `inv-${lineId}`, orderId: null },
        }));
      },
    },
    invoice: {
      findMany: async (a: any) => {
        await tick();
        if (a.where.creditNotes) return page([], a.where, a.take, "invoice");
        return []; // the inline-against-charge phase: nothing to price
      },
    },
    return: {
      findMany: async (a: any) => {
        await tick();
        return page(standard, a.where, a.take, "return");
      },
    },
  };
  const read: Reader = async (fn) => {
    log.reads += 1;
    log.open += 1;
    log.maxOpen = Math.max(log.maxOpen, log.open);
    const before = queries;
    try {
      return await fn(tx);
    } finally {
      log.queriesPerRead.push(queries - before);
      log.open -= 1;
    }
  };
  return { read, log, clock, now: () => clock.t };
}

beforeEach(() => {
  rooms.mockReset();
  rooms.mockImplementation(async (_tx: unknown, batch: unknown[]) => batch.map(() => null));
});

describe("censusOrderBound shape (SA-1091 production timeout)", () => {
  it("SH-1: discovery is keyed pages, each its own read, each starting after the last id of the one before", async () => {
    const w = fake({ inlineItems: 5, standardOrders: 0 });
    await censusOrderBound(w.read, { pageSize: 2 });
    const pages = w.log.pages.filter((p) => p.model === "returnItem");
    expect(pages.map((p) => p.after)).toEqual([undefined, idOf(1), idOf(3)]);
    expect(pages.every((p) => p.take === 2)).toBe(true);
    // 3 pages = 3 reads, none of them shared with another phase
    expect(w.log.queriesPerRead.slice(0, 3)).toEqual([1, 1, 1]);
  });

  it("SH-2: the order-wide bound is read per batch of anchors, never per anchor", async () => {
    const w = fake({ inlineItems: 0, standardOrders: 250 });
    await censusOrderBound(w.read, { anchorBatch: 100 });
    expect(rooms.mock.calls.map((c) => c[1].length)).toEqual([100, 100, 50]);
  });

  it("SH-3: a long phase is cut into slices, so no read stays open past the slice", async () => {
    // every batch takes 4 s on the fake clock; a slice is 10 s: a read holds at most 3 batches (the 3rd crosses the line)
    const w = fake({ inlineItems: 0, standardOrders: 1000 });
    const readOfBatch: number[] = [];
    rooms.mockImplementation(async (_tx: unknown, batch: unknown[]) => {
      readOfBatch.push(w.log.reads);
      w.clock.t += 4000;
      return batch.map(() => null);
    });
    await censusOrderBound(w.read, { anchorBatch: 100, sliceMs: 10_000, now: w.now });
    expect(readOfBatch).toHaveLength(10);
    const perRead = new Map<number, number>();
    for (const r of readOfBatch) perRead.set(r, (perRead.get(r) ?? 0) + 1);
    expect(perRead.size).toBeGreaterThanOrEqual(4); // several reads, not one
    expect(Math.max(...perRead.values())).toBeLessThanOrEqual(3);
  });

  it("SH-4: a zero slice still moves forward, one item per read", async () => {
    const w = fake({ inlineItems: 0, standardOrders: 30 });
    await censusOrderBound(w.read, { anchorBatch: 10, sliceMs: 0 });
    expect(rooms.mock.calls.map((c) => c[1].length)).toEqual([10, 10, 10]);
  });

  it("SH-5: at most `workers` reads are open at once, and they do run side by side", async () => {
    const w = fake({ inlineItems: 0, standardOrders: 400 });
    rooms.mockImplementation(async (_tx: unknown, batch: unknown[]) => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return batch.map(() => null);
    });
    await censusOrderBound(w.read, { anchorBatch: 10, sliceMs: 0, workers: 3 });
    expect(w.log.maxOpen).toBe(3);
    const one = fake({ inlineItems: 0, standardOrders: 400 });
    await censusOrderBound(one.read, { anchorBatch: 10, sliceMs: 0 });
    expect(one.log.maxOpen).toBe(1);
  });

  it("SH-6: past the deadline no new read starts; the run throws exit code 3 and names the phase", async () => {
    const w = fake({ inlineItems: 0, standardOrders: 1000 }, 4000);
    rooms.mockImplementation(async (_tx: unknown, batch: unknown[]) => {
      w.clock.t += 4000;
      return batch.map(() => null);
    });
    const err = await censusOrderBound(w.read, {
      anchorBatch: 100,
      sliceMs: 5000,
      deadline: w.now() + 30_000,
      now: w.now,
    }).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(CensusBudgetExceeded);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain("order-wide bound");
    const readsAtStop = w.log.reads;
    await Promise.resolve();
    expect(w.log.reads).toBe(readsAtStop);
    expect(rooms.mock.calls.length).toBeLessThan(10);
  });

  it("SH-7: the numbers do not depend on page size, batch size, slice or workers", async () => {
    rooms.mockImplementation(async (_tx: unknown, batch: Array<{ orderId?: string }>) =>
      batch.map((a) => ({
        billed: 10,
        given: { notes: 0, unlinked: 0, recorded: 0, inline: 0 },
        // every third order is over
        room: Number(String(a.orderId).split("-")[1]) % 3 === 0 ? -2 : 5,
      })),
    );
    const a = await censusOrderBound(fake({ inlineItems: 7, standardOrders: 40 }).read);
    const b = await censusOrderBound(fake({ inlineItems: 7, standardOrders: 40 }).read, {
      pageSize: 3,
      anchorBatch: 4,
      sliceMs: 0,
      workers: 3,
    });
    expect(b).toEqual(a);
    expect(a.orders.scanned).toBe(47); // 40 orders + the 7 order-less invoices the inline rows sit on
    expect(a.orders.overBound).toBe(14);
    expect(a.denominators.liveInlineReturnItems).toBe(7);
  });
});
