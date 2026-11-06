import { ConflictException } from "@nestjs/common";
import { assertDeliveredDemotionAllowed } from "./delivered-demotion.guard";

/**
 * B1280: Reopen order (a DELIVERED demotion) has two refusals the web must tell apart. A paid walk-in sale is
 * WALK_IN_SALE_PAID; an order delivered on a completed route-run stop is ORDER_ROUTE_STOP_COMPLETED. Both are 409 with a
 * code, so the web shows its own fixed sentence for each and never sniffs the server's words.
 */
const db = (opts: { walkIn?: boolean; paid?: boolean; stopStatus?: string | null }) =>
  ({
    order: {
      findUnique: async () => ({ customer: { isWalkIn: opts.walkIn ?? false } }),
    },
    invoicePayment: { findFirst: async () => (opts.paid ? { id: "pay-1" } : null) },
    routeRunStop: {
      findUnique: async () => (opts.stopStatus ? { status: opts.stopStatus } : null),
    },
  }) as unknown as Parameters<typeof assertDeliveredDemotionAllowed>[0];

const run = (d: ReturnType<typeof db>, stopId: string | null) =>
  assertDeliveredDemotionAllowed(d, { id: "o1", routeRunStopId: stopId }).catch((e) => e);

describe("assertDeliveredDemotionAllowed (B1280 codes)", () => {
  it("an order on a COMPLETED run stop is refused with 409 ORDER_ROUTE_STOP_COMPLETED", async () => {
    const err = await run(db({ stopStatus: "COMPLETED" }), "stop-1");
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "ORDER_ROUTE_STOP_COMPLETED" });
  });

  it("a paid walk-in sale is refused with 409 WALK_IN_SALE_PAID (unchanged)", async () => {
    const err = await run(db({ walkIn: true, paid: true }), null);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "WALK_IN_SALE_PAID" });
  });

  it("an order on a stop that is not completed, or on none, reopens", async () => {
    await expect(run(db({ stopStatus: "PENDING" }), "stop-1")).resolves.toBeUndefined();
    await expect(run(db({}), null)).resolves.toBeUndefined();
  });
});
