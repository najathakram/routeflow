/**
 * F-05 (#2093, owner ruling 2026-09-25): "At-door delivery of an order placed before a ban: deliver up to the
 * ordered quantity. Any increase, added line or substitution is BLOCKED, and the driver sees why."
 * `completeWithPayment` is therefore an EXEMPT row in the selling-restrictions coverage table — but only
 * because THIS check makes it true: a delivery may never exceed the ordered quantity, and may only name a
 * line of an order already on the stop. These pins are what the exemption stands on.
 *
 * B785/SA-116/SA-133/SA-345a: the bound is REMAINING (ordered − delivered at other stops), which nests
 * inside the ordered-qty ceiling (SA-365 R2). SA-366: the run projection serves that same `remaining`.
 */
import * as fs from "fs";
import * as ts from "typescript";
import * as path from "path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { assertDeliveriesFitStop, claimStopStatusChangeOnLiveRun } from "./delivery-lines.util";
import { attachDeliveredSoFar } from "./run-delivered-so-far";
import { groupEvidenceRowsByLine, RawEvidenceRowWithStop } from "./delivered-so-far";

function mockTx(item: Record<string, unknown>, priorEvidence: any[]) {
  return {
    orderItem: { findMany: jest.fn().mockResolvedValue([item]) },
    deliveryMutation: { findMany: jest.fn().mockResolvedValue(priorEvidence) },
  };
}

describe("assertDeliveriesFitStop (B785/SA-116/SA-133: bounds against REMAINING, not full ordered qty)", () => {
  const item = { id: "oi1", orderId: "o1", qty: 10 };

  it("refuses a second visit that would exceed what's actually remaining, even though it's under the full ordered qty", async () => {
    // 7 of 10 already delivered at a DIFFERENT prior stop.
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-prior",
        type: "DELIVERED",
        quantityDelivered: 7,
      },
    ]);

    const p = assertDeliveriesFitStop(
      tx,
      "stop-now",
      [{ id: "o1" }],
      [{ orderItemId: "oi1", quantityDelivered: 5 }],
    );
    await expect(p).rejects.toThrow(BadRequestException);
    // SA-365 R3: a money pin names the NUMBERS, not just the wording.
    await expect(p).rejects.toThrow(/3 left, 7 delivered earlier/);
  });

  it("accepts a second visit that fits within what's remaining", async () => {
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-prior",
        type: "DELIVERED",
        quantityDelivered: 7,
      },
    ]);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 3 }],
      ),
    ).resolves.toBeUndefined();
  });

  it("a prior REFUSED visit leaves the full ordered qty available to a later re-delivery", async () => {
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-prior",
        type: "REFUSED",
        quantityDelivered: 0,
      },
    ]);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 10 }],
      ),
    ).resolves.toBeUndefined();
  });

  it("a first-ever visit (no prior evidence) is still bounded by the full ordered qty", async () => {
    const tx = mockTx(item, []);

    const p = assertDeliveriesFitStop(
      tx,
      "stop-now",
      [{ id: "o1" }],
      [{ orderItemId: "oi1", quantityDelivered: 11 }],
    );
    await expect(p).rejects.toThrow(BadRequestException);
    // SA-365 R3: 11 of 10 on a first visit.
    await expect(p).rejects.toThrow(/10 left, 0 delivered earlier/);
  });

  it("SA-133: excludes THIS stop's own rows from the sum, so an idempotency replay never double-counts its own prior attempt", async () => {
    // A row already exists at THIS SAME stop (e.g. a defensive re-check mid-replay) —
    // it must not count against the very delivery it belongs to.
    const tx = mockTx(item, [
      {
        orderId: "o1",
        orderItemId: "oi1",
        routeRunStopId: "stop-now",
        type: "DELIVERED",
        quantityDelivered: 7,
      },
    ]);

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 10 }],
      ),
    ).resolves.toBeUndefined();
  });

  it("still 404s an order item the tenant-scoped read can't find", async () => {
    const tx = {
      orderItem: { findMany: jest.fn().mockResolvedValue([]) },
      deliveryMutation: { findMany: jest.fn().mockResolvedValue([]) },
    };

    await expect(
      assertDeliveriesFitStop(
        tx,
        "stop-now",
        [{ id: "o1" }],
        [{ orderItemId: "oi1", quantityDelivered: 1 }],
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("assertDeliveriesFitStop — the at-door ceiling", () => {
  const stopId = "stop-now";
  const stopOrders = [{ id: "o1" }];
  // SA-365 R5: master's block adapted mechanically — the stopId arg, and no prior evidence.
  const tx = (items: Record<string, unknown>[], evidence: any[] = []) => ({
    orderItem: { findMany: jest.fn().mockResolvedValue(items) },
    deliveryMutation: { findMany: jest.fn().mockResolvedValue(evidence) },
  });
  const item = { id: "i1", orderId: "o1", qty: 10 };

  it("allows up to the ordered quantity (what was ordered may be delivered), including short and zero", async () => {
    for (const q of [10, 7, 0]) {
      await expect(
        assertDeliveriesFitStop(tx([item]), stopId, stopOrders, [
          { orderItemId: "i1", quantityDelivered: q },
        ]),
      ).resolves.toBeUndefined();
    }
  });

  it("refuses ANY increase over the ordered quantity, and says why", async () => {
    const p = assertDeliveriesFitStop(tx([item]), stopId, stopOrders, [
      { orderItemId: "i1", quantityDelivered: 11 },
    ]);
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    // SA-365 R3: the SA-151 readable text, pinned on its numbers.
    await expect(p).rejects.toThrow(/10 left, 0 delivered earlier/);
  });

  it("refuses an added line: an item that is not on the stop's orders", async () => {
    await expect(
      assertDeliveriesFitStop(tx([{ id: "i9", orderId: "other", qty: 5 }]), stopId, stopOrders, [
        { orderItemId: "i9", quantityDelivered: 1 },
      ]),
    ).rejects.toThrow(/does not belong to this stop/);
  });

  it("refuses a substitution: an unknown item and a duplicated line", async () => {
    await expect(
      assertDeliveriesFitStop(tx([]), stopId, stopOrders, [
        { orderItemId: "ghost", quantityDelivered: 1 },
      ]),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      assertDeliveriesFitStop(tx([item]), stopId, stopOrders, [
        { orderItemId: "i1", quantityDelivered: 1 },
        { orderItemId: "i1", quantityDelivered: 2 },
      ]),
    ).rejects.toThrow(/more than one delivery line/);
  });

  it("caps a CANCELLED line, and a line of a CANCELLED or DRAFT order still on the stop, at 0", async () => {
    const cases = [
      { ...item, status: "CANCELLED", order: { status: "CONFIRMED" } },
      { ...item, status: "PENDING", order: { status: "CANCELLED" } },
      { ...item, status: "PENDING", order: { status: "DRAFT" } },
    ];
    for (const c of cases) {
      const p = assertDeliveriesFitStop(tx([c]), stopId, stopOrders, [
        { orderItemId: "i1", quantityDelivered: 10 },
      ]);
      await expect(p).rejects.toBeInstanceOf(BadRequestException);
      // a DRAFT order's line is NOT "cancelled": it has its own wording
      await expect(p).rejects.toThrow(
        c.order.status === "DRAFT" ? /not confirmed yet/ : /was cancelled/,
      );
      // the ceiling of 0 is EXACT: a sliver of a cancelled line is refused too (no 0.0005 epsilon)
      await expect(
        assertDeliveriesFitStop(tx([c]), stopId, stopOrders, [
          { orderItemId: "i1", quantityDelivered: 0.0005 },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      // delivering nothing against it stays legal (a driver can close the stop)
      await expect(
        assertDeliveriesFitStop(tx([c]), stopId, stopOrders, [
          { orderItemId: "i1", quantityDelivered: 0 },
        ]),
      ).resolves.toBeUndefined();
    }
  });

  it("SA-365 R4: a not-ordered refusal names the product, not the order item id", async () => {
    const named = {
      ...item,
      name: "Line name",
      product: { name: "Acme Widget" },
      status: "CANCELLED",
      order: { status: "CONFIRMED" },
    };
    const p = assertDeliveriesFitStop(tx([named]), stopId, stopOrders, [
      { orderItemId: "i1", quantityDelivered: 1 },
    ]);
    await expect(p).rejects.toThrow(/^Acme Widget was cancelled/);
    await expect(p).rejects.not.toThrow(/i1/);
  });

  describe("SA-365 R5: a not-ordered line with delivery evidence elsewhere still caps at exactly 0", () => {
    const cancelled = { ...item, status: "CANCELLED", order: { status: "CONFIRMED" } };
    const prior = [
      {
        orderId: "o1",
        orderItemId: "i1",
        routeRunStopId: "stop-prior",
        type: "DELIVERED",
        quantityDelivered: 3,
      },
    ];

    it("(i) the bound: q=1 and q=0.0005 refused, q=0 allowed", async () => {
      for (const q of [1, 0.0005]) {
        await expect(
          assertDeliveriesFitStop(tx([cancelled], prior), stopId, stopOrders, [
            { orderItemId: "i1", quantityDelivered: q },
          ]),
        ).rejects.toThrow(/was cancelled/);
      }
      await expect(
        assertDeliveriesFitStop(tx([cancelled], prior), stopId, stopOrders, [
          { orderItemId: "i1", quantityDelivered: 0 },
        ]),
      ).resolves.toBeUndefined();
    });

    it("(ii) the served `remaining` for that line is 0 (SA-366)", () => {
      const [stop] = attachDeliveredSoFar(
        [
          {
            id: stopId,
            orders: [
              {
                id: "o1",
                status: "CONFIRMED",
                lineItems: [{ id: "i1", qty: 10, deliveredQty: 3, status: "CANCELLED" }],
              },
            ],
          },
        ],
        groupEvidenceRowsByLine(prior),
      );
      expect(stop.orders[0].lineItems[0]).toMatchObject({ deliveredSoFar: 3, remaining: 0 });
    });
  });

  describe("structure: both stop-completion paths run the ceiling before any delivery write", () => {
    const src = ts.createSourceFile(
      "routes.service.ts",
      fs.readFileSync(path.join(__dirname, "routes.service.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const method = (name: string) => {
      let found: ts.MethodDeclaration | undefined;
      const walk = (n: ts.Node) => {
        if (ts.isMethodDeclaration(n) && n.name.getText(src) === name) found = n;
        ts.forEachChild(n, walk);
      };
      walk(src);
      return found!;
    };
    /** Start offsets of every call `x.y(...)` whose callee text ends with `suffix`, inside the method body. */
    const calls = (m: ts.MethodDeclaration, suffix: string) => {
      const at: number[] = [];
      const walk = (n: ts.Node) => {
        if (ts.isCallExpression(n) && n.expression.getText(src).endsWith(suffix))
          at.push(n.getStart(src));
        ts.forEachChild(n, walk);
      };
      walk(m.body!);
      return at.sort((a, b) => a - b);
    };

    it.each(["completeWithPayment", "completeStop"])("%s", (name) => {
      const m = method(name);
      // SA-706c: completeWithPayment runs the ceiling through lockStopOrdersAndFit (the stop's Orders
      // locked first, then assertDeliveriesFitStop); completeStop still calls it directly.
      const guard = [
        ...calls(m, "assertDeliveriesFitStop"),
        ...calls(m, "lockStopOrdersAndFit"),
      ].sort((a, b) => a - b);
      const writes = [...calls(m, "orderItem.update"), ...calls(m, "deliveryMutation.create")];
      expect(guard.length).toBeGreaterThan(0);
      expect(writes.length).toBeGreaterThan(0);
      expect(guard[0]).toBeLessThan(Math.min(...writes));
    });
  });
});

/**
 * SA-366: the projected `remaining` IS the largest quantity the bound accepts — one predicate
 * (lineRemaining) behind both, so the driver's default can never be refused and never under-offer.
 * Table: notOrdered × {no rows, other-stop rows, own-stop-only rows, column-only}.
 */
describe("SA-366: projected `remaining` === the largest q the bound accepts", () => {
  const stopId = "stop-now";
  type Case = {
    evidence: string;
    rows: RawEvidenceRowWithStop[];
    deliveredQty: number;
  };
  const row = (routeRunStopId: string, quantityDelivered: number): RawEvidenceRowWithStop => ({
    orderId: "o1",
    orderItemId: "i1",
    routeRunStopId,
    type: "DELIVERED",
    quantityDelivered,
  });
  const evidence: Case[] = [
    { evidence: "no rows, column 0", rows: [], deliveredQty: 0 },
    { evidence: "other-stop rows", rows: [row("stop-prior", 4)], deliveredQty: 4 },
    { evidence: "own-stop-only rows", rows: [row(stopId, 6)], deliveredQty: 6 },
    { evidence: "column-only (legacy)", rows: [], deliveredQty: 7 },
  ];
  const statuses = [
    { label: "ordered", lineStatus: "PENDING", orderStatus: "CONFIRMED", notOrdered: false },
    {
      label: "line CANCELLED",
      lineStatus: "CANCELLED",
      orderStatus: "CONFIRMED",
      notOrdered: true,
    },
    { label: "order CANCELLED", lineStatus: "PENDING", orderStatus: "CANCELLED", notOrdered: true },
    { label: "order DRAFT", lineStatus: "PENDING", orderStatus: "DRAFT", notOrdered: true },
  ];
  const table = statuses.flatMap((s) => evidence.map((e) => ({ ...s, ...e })));

  it.each(table)("$label × $evidence", async (c) => {
    const [stop] = attachDeliveredSoFar(
      [
        {
          id: stopId,
          orders: [
            {
              id: "o1",
              status: c.orderStatus,
              lineItems: [
                { id: "i1", qty: 10, deliveredQty: c.deliveredQty, status: c.lineStatus },
              ],
            },
          ],
        },
      ],
      groupEvidenceRowsByLine(c.rows),
    );
    const remaining = stop.orders[0].lineItems[0].remaining;
    const bound = (q: number) =>
      assertDeliveriesFitStop(
        {
          orderItem: {
            findMany: jest.fn().mockResolvedValue([
              {
                id: "i1",
                orderId: "o1",
                qty: 10,
                deliveredQty: c.deliveredQty,
                name: null,
                product: { name: "Acme Widget" },
                status: c.lineStatus,
                order: { status: c.orderStatus },
              },
            ]),
          },
          deliveryMutation: { findMany: jest.fn().mockResolvedValue(c.rows) },
        },
        stopId,
        [{ id: "o1" }],
        [{ orderItemId: "i1", quantityDelivered: q }],
      );

    if (c.notOrdered) {
      expect(remaining).toBe(0);
      await expect(bound(0.0005)).rejects.toBeInstanceOf(BadRequestException);
      await expect(bound(0)).resolves.toBeUndefined();
    } else {
      expect(remaining).toBeGreaterThan(0);
      await expect(bound(remaining)).resolves.toBeUndefined();
      await expect(bound(remaining + 1)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

// #2292: a units_v1 line stores qty in BASE PIECES (count × factor), so the refusal used to read
// "0 left, 120 delivered earlier" while the driver's stepper for the same line says "3 Cases". The
// refusal now counts in the line's own unit via the SA-388 derivation (boxes when a positive
// integer, else qty ÷ the snapshot unitsPerBox when whole), falls back to pieces labelled "pieces"
// when the line is LOCKED, and leaves a pack line exactly as it was.
describe("assertDeliveriesFitStop — refusal counts in the line's unit (#2292)", () => {
  const prior = (qty: number) => [
    {
      orderId: "o1",
      orderItemId: "oi1",
      routeRunStopId: "stop-prior",
      type: "DELIVERED",
      quantityDelivered: qty,
    },
  ];
  const deliver = (item: Record<string, unknown>, priorQty: number, q: number) =>
    assertDeliveriesFitStop(
      mockTx({ id: "oi1", orderId: "o1", ...item }, prior(priorQty)),
      "stop-now",
      [{ id: "o1" }],
      [{ orderItemId: "oi1", quantityDelivered: q }],
    );
  // 10 Cases of 12, stored the units_v1 way: boxes = count, qty = count × factor.
  const caseLine = {
    qty: 120,
    boxes: 10,
    pieces: 0,
    unitsPerBox: 12,
    unitLabel: "Case",
    product: { name: "Sparkling Water" },
  };

  it("fully delivered earlier: '0 Cases left, 10 Cases delivered earlier' — never '0 left, 120 delivered'", async () => {
    await expect(deliver(caseLine, 120, 12)).rejects.toThrow(
      "Sparkling Water: 0 Cases left, 10 Cases delivered earlier — refresh the stop",
    );
  });

  it("partly delivered: '3 Cases left, 7 Cases delivered earlier'; one Case stays singular", async () => {
    await expect(deliver(caseLine, 84, 48)).rejects.toThrow(
      "Sparkling Water: 3 Cases left, 7 Cases delivered earlier",
    );
    await expect(deliver(caseLine, 108, 24)).rejects.toThrow(
      "Sparkling Water: 1 Case left, 9 Cases delivered earlier",
    );
  });

  it("no split stored: the count comes from qty ÷ the snapshot unitsPerBox when whole", async () => {
    await expect(deliver({ ...caseLine, boxes: null, pieces: null }, 120, 12)).rejects.toThrow(
      "Sparkling Water: 0 Cases left, 10 Cases delivered earlier",
    );
  });

  it("LOCKED line (qty not a whole multiple, no usable boxes): pieces, labelled 'pieces'", async () => {
    await expect(
      deliver({ ...caseLine, qty: 40, boxes: 0, unitsPerBox: 12 }, 40, 12),
    ).rejects.toThrow("Sparkling Water: 0 pieces left, 40 pieces delivered earlier");
  });

  it("a remainder that is not a whole unit is stated in pieces, never a fractional Case", async () => {
    await expect(deliver(caseLine, 7, 120)).rejects.toThrow(
      "Sparkling Water: 113 pieces left, 7 pieces delivered earlier",
    );
  });

  it("a pack line (no unitLabel) is unchanged", async () => {
    await expect(
      deliver(
        { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, product: { name: "Crackers" } },
        24,
        1,
      ),
    ).rejects.toThrow("Crackers: 0 left, 24 delivered earlier — refresh the stop");
  });
});

describe("claimStopStatusChangeOnLiveRun (#2514, SA-533e — stop → run house order)", () => {
  const make = (runStatus: string | null) => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async () => (calls.push("lock"), 1)),
      routeRun: {
        findFirst: jest.fn(
          async () => (calls.push("read"), runStatus ? { status: runStatus } : null),
        ),
      },
      routeRunStop: {
        updateMany: jest.fn(async () => (calls.push("cas"), { count: 1 })),
        findUnique: jest.fn(),
      },
    };
    const prisma = { tenantTransaction: jest.fn(async (fn: any) => fn(tx)) };
    return { prisma, tx, calls };
  };

  it("the stop CAS FIRST, then the run row lock, then the re-read — all on one tx", async () => {
    const { prisma, calls } = make("IN_PROGRESS");
    await claimStopStatusChangeOnLiveRun(prisma, "run-1", "stop-1", { status: "SKIPPED" });
    expect(calls).toEqual(["cas", "lock", "read"]);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(["COMPLETED", "CANCELLED"])(
    "a %s run (seen under the lock) is a 409 thrown INSIDE the tx, so the stop CAS rolls back",
    async (status) => {
      const { prisma, calls } = make(status);
      await expect(
        claimStopStatusChangeOnLiveRun(prisma, "run-1", "stop-1", { status: "SKIPPED" }),
      ).rejects.toThrow(`Cannot change a stop on a ${status.toLowerCase()} run.`);
      // The CAS ran first (the house order); the throw after the run re-read rejects the SAME
      // tenantTransaction callback — Postgres rolls the stop write back (real-PG pin: F2's latch).
      expect(calls).toEqual(["cas", "lock", "read"]);
      await expect(prisma.tenantTransaction.mock.results[0].value).rejects.toThrow();
    },
  );

  it("a run gone under the lock is a 404", async () => {
    const { prisma } = make(null);
    await expect(claimStopStatusChangeOnLiveRun(prisma, "run-1", "stop-1", {})).rejects.toThrow(
      "Route run not found",
    );
  });
});
