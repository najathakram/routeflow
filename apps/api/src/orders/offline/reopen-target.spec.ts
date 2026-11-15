import { OrderStatus } from "@prisma/client";
import { ORDER_REVIEW_FLAG_KIND_VALUES } from "@routeflow/types";
import { reopenTarget } from "./reopen-target";
import { GATE_FLAG_KINDS } from "./review-flags";

/** SA-1134 R-1: the status a cancelled order reopens to. Only an OPEN GATE flag makes it a DRAFT. */
describe("reopenTarget", () => {
  /** A flag table that applies the `where` the helper sends: orderId, kind in [...], resolvedAt null. */
  const dbWith = (
    flags: Array<{ orderId: string; kind: string; resolvedAt: Date | null }>,
  ): { orderReviewFlag: { count: jest.Mock } } => ({
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
  });

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
