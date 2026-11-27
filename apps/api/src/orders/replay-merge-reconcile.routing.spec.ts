/**
 * SA-1544 (ao): the merge replay routes by the SAME rule as the fold, with the same third input: a held live delivered line
 * routes in place (supersedes A1 B4's "the replay passes false"). The routing decision is the `postDeliveryEdit` the replay
 * hands to the convergent tail.
 */
import { Logger } from "@nestjs/common";
import { replayMergeReconcile } from "./replay-merge-reconcile";

const order = (status: string, lines: any[]) => ({
  id: "o1",
  tenantId: "t",
  status,
  fulfillPath: "DELIVERY",
  shippedAt: null,
  lineItems: lines,
});

function run(o: ReturnType<typeof order>) {
  const reconcile = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    getTenantId: () => "t",
    forTenant: () => ({
      order: { findFirst: jest.fn().mockResolvedValue(o) },
      invoice: { count: jest.fn().mockResolvedValue(0) },
    }),
  };
  return replayMergeReconcile(
    { prisma, featureConfig: undefined, logger: new Logger("x"), reconcile },
    "o1",
    "c1",
    undefined,
  ).then(() => reconcile.mock.calls[0][3]);
}

describe("SA-1544 (ao) replayMergeReconcile routing", () => {
  it("a CONFIRMED order holding a live delivered line routes in place, like the fold", async () => {
    const opts = await run(
      order("CONFIRMED", [{ qty: 10, invoicedQty: 10, deliveredQty: 4, status: "PENDING" }]),
    );
    expect(opts.postDeliveryEdit).toBe(true); // wrong value: false (the replay passed false)
  });

  it("a CONFIRMED order holding no live delivered line keeps master's path", async () => {
    const opts = await run(
      order("CONFIRMED", [{ qty: 10, invoicedQty: 0, deliveredQty: 0, status: "PENDING" }]),
    );
    expect(opts.postDeliveryEdit).toBe(false);
  });

  it("a cancelled delivered line does not route it in place", async () => {
    const opts = await run(
      order("CONFIRMED", [{ qty: 10, invoicedQty: 0, deliveredQty: 4, status: "CANCELLED" }]),
    );
    expect(opts.postDeliveryEdit).toBe(false);
  });
});
