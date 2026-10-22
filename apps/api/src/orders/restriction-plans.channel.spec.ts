import { planChangeRequestRestrictions } from "./change-request-restrictions";
import { planOrderEditRestrictions } from "./order-edit-restrictions";

/**
 * Row 510 (was portal limits, lane A): the tenant switch no longer gates ANY channel. The two order-path plans
 * (`updateOrderItems`, at-door change-request approval) are built for every principal: a buyer's edit is judged at the
 * portal channel (a hard 409), a staff edit at the staff channel (a warning the office may override). Neither reads the
 * tenant policy any more, and every judged line carries the warning key the client echoes back.
 */
const T = "tenant-1";
/** An operator is STAFF; a customer (or an unknown principal) is the portal. */
const who = (channel: "STAFF" | "BUYER_PORTAL") =>
  channel === "STAFF" ? { role: "OPERATOR" } : { role: "CUSTOMER" };

describe("planOrderEditRestrictions: every channel is planned", () => {
  const prisma = {
    forTenant: () => ({ product: { findMany: jest.fn().mockResolvedValue([]) } }),
  } as never;
  const args = (channel: "STAFF" | "BUYER_PORTAL") => ({
    tenantId: T,
    customerId: "c1",
    existing: [],
    items: [{ productId: "p1", qty: 2 }],
    mode: { kind: "merge" as const },
    principal: who(channel),
    fulfilmentKind: "DELIVERY" as const,
  });

  it("STAFF: planned, the line keyed by its payload index", async () => {
    const plan = await planOrderEditRestrictions(prisma, args("STAFF"));
    // an add with no resolvable size is always checked (fail closed): the line carries only its product
    expect(plan.params.lines).toEqual([{ productId: "p1", lineKey: "n:0" }]);
    expect(plan.params.document).toBe("ORDER");
  });

  it("BUYER_PORTAL: planned, so the choke point judges the buyer's add", async () => {
    const plan = await planOrderEditRestrictions(prisma, args("BUYER_PORTAL"));
    expect(plan.params.lines).toEqual([{ productId: "p1", lineKey: "n:0" }]);
    expect(plan.params.principal).toEqual({ role: "CUSTOMER" }); // the call site derives the portal channel from it
  });
});

describe("planChangeRequestRestrictions: every channel is planned", () => {
  const args = (channel: "STAFF" | "BUYER_PORTAL") => ({
    tenantId: T,
    customerId: "c1",
    existing: [],
    cr: { id: "cr1", type: "ADD_ITEM", productId: "p1" },
    principal: who(channel),
    fulfilmentKind: "DELIVERY" as const,
  });

  it("STAFF: planned, the line keyed by the change request", () => {
    const plan = planChangeRequestRestrictions(args("STAFF"));
    expect(plan.params.lines).toEqual([{ productId: "p1", lineKey: "cr:cr1" }]);
  });

  it("BUYER_PORTAL: planned", () => {
    const plan = planChangeRequestRestrictions(args("BUYER_PORTAL"));
    expect(plan.params.principal).toEqual({ role: "CUSTOMER" });
  });
});
