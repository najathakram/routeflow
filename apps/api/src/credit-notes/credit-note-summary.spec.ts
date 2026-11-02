import { UserRole } from "@prisma/client";
import { computeCreditNoteSummary } from "./credit-note-summary";

/**
 * B238: the credit-notes page's counters and tiles are computed by the SERVER over every note, never a client
 * `useCreditNotes({ limit: 999 })` fetch-all, which silently drops whichever rows page 1000+ would have held.
 */
type Row = Record<string, unknown>;

const NOW = new Date("2026-11-02T12:00:00.000Z");
const staff = { sub: "u1", role: UserRole.OPERATOR, tenantId: "t1" } as any;

function note(i: number, over: Row = {}): Row {
  return {
    id: `cn-${i}`,
    status: "ISSUED",
    amount: "10.00",
    amountUsed: "0.00",
    expiresAt: null,
    reason: "Damaged",
    createdAt: new Date("2026-10-30T08:00:00.000Z"),
    ...over,
  };
}

function deps(
  notes: Row[],
  opts: { tenantId?: string | null; customer?: { id: string } | null } = {},
) {
  const findMany = jest.fn(async (arg: { where: Row }) =>
    notes.filter(
      (n) => !(arg.where.status as any)?.not || n.status !== (arg.where.status as any).not,
    ),
  );
  const groupBy = jest.fn(async () => {
    const by = new Map<string, number>();
    for (const n of notes) by.set(n.status as string, (by.get(n.status as string) ?? 0) + 1);
    return [...by].map(([status, count]) => ({ status, _count: { _all: count } }));
  });
  const customerFindFirst = jest.fn(async () => opts.customer ?? null);
  const prisma = {
    getTenantId: () => (opts.tenantId === undefined ? "t1" : opts.tenantId),
    forTenant: () => ({
      creditNote: { findMany, groupBy },
      customer: { findFirst: customerFindFirst },
    }),
  };
  return { prisma: prisma as any, findMany, groupBy, customerFindFirst };
}

describe("B238 computeCreditNoteSummary", () => {
  it("REG-B238: 1,500 notes are all counted and summed; no row cap is passed to the database", async () => {
    // 1,200 issued ($10.00, $4.00 used), 200 applied (fully used), 100 void. A limit:999 client undercounts all three.
    const notes: Row[] = [];
    for (let i = 0; i < 1200; i++) notes.push(note(i, { amountUsed: "4.00" }));
    for (let i = 0; i < 200; i++)
      notes.push(note(2000 + i, { status: "APPLIED", amountUsed: "10.00" }));
    for (let i = 0; i < 100; i++) notes.push(note(3000 + i, { status: "VOID" }));
    const d = deps(notes);
    const out = await computeCreditNoteSummary(d, "2026-11-02", staff, NOW);
    expect(out.counts).toEqual({ total: 1500, issued: 1200, applied: 200, void: 100 });
    expect(out.openCount).toBe(1200);
    expect(out.openCredit).toBe(7200); // 1,200 x ($10.00 - $4.00), never the full $10.00 of a part-used note
    for (const call of d.findMany.mock.calls) expect(call[0]).not.toHaveProperty("take");
  });

  it("open credit is the canonical predicate: not void, balance left, not expired", async () => {
    const d = deps([
      note(1), // 10.00 open
      note(2, { amountUsed: "10.00" }), // spent
      note(3, { status: "VOID" }), // void
      note(4, { expiresAt: new Date("2026-11-01T00:00:00.000Z") }), // expired yesterday
      note(5, { expiresAt: new Date("2026-12-01T00:00:00.000Z"), amountUsed: "2.50" }), // 7.50 open
    ]);
    const out = await computeCreditNoteSummary(d, "2026-11-02", staff, NOW);
    expect(out.openCount).toBe(2);
    expect(out.openCredit).toBe(17.5);
  });

  it("cents are summed per note and rounded (no 0.1 + 0.2 float drift)", async () => {
    const d = deps([
      note(1, { amount: "0.10" }),
      note(2, { amount: "0.20" }),
      note(3, { amount: "0.30" }),
    ]);
    const out = await computeCreditNoteSummary(d, "2026-11-02", staff, NOW);
    expect(out.openCredit).toBe(0.6);
    expect(out.issued30Value).toBe(0.6);
  });

  it("issued in the last 30 days: by creation date, void excluded, the viewer's calendar day sets the cutoff", async () => {
    const d = deps([
      note(1, { createdAt: new Date("2026-10-03T00:00:00.000Z") }), // exactly 30 days before 2026-11-02: in
      note(2, { createdAt: new Date("2026-10-02T23:59:59.000Z") }), // a second earlier: out
      note(3, { createdAt: new Date("2026-11-01T10:00:00.000Z"), status: "VOID" }), // void: out
      note(4, { createdAt: new Date("2026-11-02T09:00:00.000Z"), amount: "5.00" }), // in
    ]);
    const out = await computeCreditNoteSummary(d, "2026-11-02", staff, NOW);
    expect(out.issued30Count).toBe(2);
    expect(out.issued30Value).toBe(15);
  });

  it("top reason by credited value over the non-void notes, with its share", async () => {
    const d = deps([
      note(1, { reason: "Damaged", amount: "30.00" }),
      note(2, { reason: "Short ship", amount: "50.00" }),
      note(3, { reason: " Short ship ", amount: "20.00" }),
      note(4, { reason: "Damaged", amount: "500.00", status: "VOID" }), // void never counts
      note(5, { reason: null, amount: "0.00" }),
    ]);
    const out = await computeCreditNoteSummary(d, "2026-11-02", staff, NOW);
    expect(out.topReason).toBe("Short ship");
    expect(out.topReasonPct).toBe(70); // 70 of 100
  });

  it("nothing credited reads as no top reason and 0%", async () => {
    const out = await computeCreditNoteSummary(deps([]), "2026-11-02", staff, NOW);
    expect(out).toEqual({
      counts: { total: 0, issued: 0, applied: 0, void: 0 },
      openCredit: 0,
      openCount: 0,
      issued30Value: 0,
      issued30Count: 0,
      topReason: "—",
      topReasonPct: 0,
    });
  });

  it("a buyer sees only their own notes; a buyer with no customer profile, a driver and no tenant see zeros", async () => {
    const own = deps([note(1)], { customer: { id: "c9" } });
    await computeCreditNoteSummary(
      own,
      "2026-11-02",
      { sub: "b1", role: UserRole.CUSTOMER } as any,
      NOW,
    );
    expect((own.findMany.mock.calls[0][0] as any).where.customerId).toBe("c9");
    expect((own.groupBy.mock.calls[0] as any)[0].where.customerId).toBe("c9");

    for (const [d, user] of [
      [deps([note(1)], { customer: null }), { sub: "b1", role: UserRole.CUSTOMER }],
      [deps([note(1)]), { sub: "d1", role: UserRole.DRIVER }],
      [deps([note(1)], { tenantId: null }), staff],
    ] as const) {
      const out = await computeCreditNoteSummary(d, "2026-11-02", user as any, NOW);
      expect(out.counts.total).toBe(0);
      expect(out.openCredit).toBe(0);
    }
  });

  it("a day that does not exist is a 400, not a silent roll-over", async () => {
    await expect(
      computeCreditNoteSummary(deps([]), "2026-02-30", staff, NOW),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("B238 route order", () => {
  it('GET summary is declared before GET :id, so "summary" is never read as a credit-note id', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require("fs").readFileSync(
      require("path").join(__dirname, "credit-notes.controller.ts"),
      "utf8",
    );
    const summary = src.indexOf('@Get("summary")');
    expect(summary).toBeGreaterThan(-1);
    expect(summary).toBeLessThan(src.indexOf('@Get(":id")'));
  });
});
