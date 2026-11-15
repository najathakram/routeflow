import { ConflictException, Logger } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { ORDER_REVIEW_FLAG_KIND_VALUES } from "@routeflow/types";
import { cancelledFrom, reopenTarget } from "./reopen-target";
import { GATE_FLAG_KINDS } from "./review-flags";

type Flag = { orderId: string; kind: string; resolvedAt: Date | null };
type Row = { action: string; meta: unknown } | null;

/** SA-1134 R-1 and SA-1136: the status a cancelled order reopens to. */
describe("reopenTarget", () => {
  /** A flag table that applies the `where` the helper sends, and an audit table whose newest row is `newest`. */
  const dbWith = (flags: Flag[], newest: Row = null) => ({
    orderReviewFlag: {
      count: jest.fn(
        async ({ where }: any) =>
          flags.filter(
            (f) =>
              f.orderId === where.orderId &&
              where.kind.in.includes(f.kind) &&
              f.resolvedAt === where.resolvedAt,
          ).length,
      ),
    },
    auditLog: { findFirst: jest.fn(async () => newest) },
  });
  const gate = (resolvedAt: Date | null = null, orderId = "o1"): Flag => ({
    orderId,
    kind: "CREDIT_BLOCKED",
    resolvedAt,
  });
  const cancelledRow = (fromStatus: unknown): Row => ({
    action: "order.cancelled",
    meta: { fromStatus },
  });

  describe("legacy (no recorded cancel): an open gate flag is the only thing that makes a DRAFT (SA-1134 R-1)", () => {
    it.each([...ORDER_REVIEW_FLAG_KIND_VALUES])(
      "an order whose only open flag is %s reopens to DRAFT exactly when that kind is a gate kind",
      async (kind) => {
        const db = dbWith([{ orderId: "o1", kind, resolvedAt: null }]);
        const expected = (GATE_FLAG_KINDS as readonly string[]).includes(kind)
          ? OrderStatus.DRAFT
          : OrderStatus.PENDING;
        expect(await reopenTarget(db, "o1")).toBe(expected);
      },
    );

    it("a gate flag that a promotion resolved no longer holds the order in DRAFT", async () => {
      const db = dbWith(
        GATE_FLAG_KINDS.map((kind) => ({ orderId: "o1", kind, resolvedAt: new Date() })),
      );
      expect(await reopenTarget(db, "o1")).toBe(OrderStatus.PENDING);
    });

    it("an order with no flags, or only another order's flags, reopens to PENDING", async () => {
      const db = dbWith([{ orderId: "o2", kind: "CREDIT_BLOCKED", resolvedAt: null }]);
      expect(await reopenTarget(db, "o1")).toBe(OrderStatus.PENDING);
      expect(await reopenTarget(dbWith([]), "o1")).toBe(OrderStatus.PENDING);
    });

    it("one open gate flag among resolved and manual ones is enough", async () => {
      const db = dbWith([
        { orderId: "o1", kind: "PRICE_CHANGED_OFFLINE", resolvedAt: null },
        { orderId: "o1", kind: "RESTRICTED", resolvedAt: new Date() },
        { orderId: "o1", kind: "LICENSE_REQUIRED", resolvedAt: null },
      ]);
      expect(await reopenTarget(db, "o1")).toBe(OrderStatus.DRAFT);
    });
  });

  describe("SA-1136: the recorded cancel decides", () => {
    it("row 1: cancelled from DRAFT reopens to DRAFT, with or without a gate flag", async () => {
      expect(await reopenTarget(dbWith([], cancelledRow("DRAFT")), "o1")).toBe(OrderStatus.DRAFT);
      expect(await reopenTarget(dbWith([gate()], cancelledRow("DRAFT")), "o1")).toBe(
        OrderStatus.DRAFT,
      );
    });

    it("row 3: cancelled from a live status reopens to PENDING", async () => {
      for (const from of ["PENDING", "CONFIRMED", "IN_PREPARATION", "READY", "PARTIALLY_DELIVERED"])
        expect(await reopenTarget(dbWith([], cancelledRow(from)), "o1")).toBe(OrderStatus.PENDING);
    });

    it("row 2: cancelled from a live status while a gate flag is open is refused (409) and logged with the order id", async () => {
      const logged = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const err = await reopenTarget(
        dbWith([gate(null, "o-9")], cancelledRow("CONFIRMED")),
        "o-9",
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "ORDER_CHANGED_DURING_EDIT" });
      expect(logged.mock.calls.some((c) => String(c[0]).includes("o-9"))).toBe(true);
      logged.mockRestore();
    });

    it("rows 4 and 5: no usable record is today's rule: DRAFT with an open gate flag, else PENDING", async () => {
      for (const newest of [null, { action: "order.reopened", meta: { toStatus: "PENDING" } }]) {
        expect(await reopenTarget(dbWith([gate()], newest), "o1")).toBe(OrderStatus.DRAFT);
        expect(await reopenTarget(dbWith([], newest), "o1")).toBe(OrderStatus.PENDING);
      }
    });

    it("reads only this order's newest cancelled-or-reopened row, newest first", async () => {
      const db = dbWith([], cancelledRow("DRAFT"));
      await reopenTarget(db, "o1");
      expect(db.auditLog.findFirst).toHaveBeenCalledWith({
        where: {
          entityType: "Order",
          entityId: "o1",
          action: { in: ["order.cancelled", "order.reopened"] },
        },
        orderBy: { createdAt: "desc" },
        select: { action: true, meta: true },
      });
    });
  });
});

/** O1-12: the pure classifier over the newest row. */
describe("cancelledFrom", () => {
  const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());
  afterAll(() => warn.mockRestore());

  it.each([
    ["no row", null, "unknown"],
    ["a reopen is newest", { action: "order.reopened", meta: { toStatus: "DRAFT" } }, "unknown"],
    ["meta {}", { action: "order.cancelled", meta: {} }, "unknown"],
    ["meta null", { action: "order.cancelled", meta: null }, "unknown"],
    ["a bogus status", { action: "order.cancelled", meta: { fromStatus: "BOGUS" } }, "unknown"],
    ["from DRAFT", { action: "order.cancelled", meta: { fromStatus: "DRAFT" } }, "draft"],
    ["from PENDING", { action: "order.cancelled", meta: { fromStatus: "PENDING" } }, "live"],
  ] as const)("%s", (_label, row, expected) => {
    expect(cancelledFrom(row as Row, "o1")).toBe(expected);
  });

  it("warns with the order id when a cancelled row exists but cannot be read, and only then", () => {
    cancelledFrom({ action: "order.cancelled", meta: {} }, "o-7");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("o-7"))).toBe(true);
    warn.mockClear();
    cancelledFrom(null, "o-8");
    cancelledFrom({ action: "order.reopened", meta: {} }, "o-8");
    expect(warn).not.toHaveBeenCalled();
  });
});
