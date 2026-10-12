import { planChangeRequestRestrictions } from "./change-request-restrictions";
import { planOrderEditRestrictions } from "./order-edit-restrictions";

/**
 * Portal limits (lane A): the tenant switch gates the STAFF channel only. The two order-path plans
 * (`updateOrderItems`, at-door change-request approval) used to return null (no judgment) whenever the
 * switch was off, which would let a buyer's edit add a product the portal hides. `restrictionsApply`
 * now decides, so a buyer's edit is always planned (and then judged by the choke point), and a staff
 * edit with the switch off still costs one policy read and nothing else.
 */
const T = "tenant-1";
/** An operator is STAFF; a customer (or an unknown principal) is the portal. */
const who = (channel: "STAFF" | "BUYER_PORTAL") =>
  channel === "STAFF" ? { role: "OPERATOR" } : { role: "CUSTOMER" };
const policy = (enabled: boolean) => ({ enabled, addressPrecedence: "BILLING_FIRST" as const });

describe("planOrderEditRestrictions: the switch is staff-channel only", () => {
  const deps = (enabled: boolean) => ({
    restrictions: { getPolicy: jest.fn().mockResolvedValue(policy(enabled)) },
    prisma: {
      forTenant: () => ({ product: { findMany: jest.fn().mockResolvedValue([]) } }),
    } as never,
  });
  const args = (channel: "STAFF" | "BUYER_PORTAL") => ({
    tenantId: T,
    existing: [],
    items: [{ productId: "p1", qty: 2 }],
    mode: { kind: "merge" as const },
    principal: who(channel),
  });

  it("switch OFF + STAFF: no plan, one policy read", async () => {
    const d = deps(false);
    expect(await planOrderEditRestrictions(d, args("STAFF"))).toBeNull();
    expect(d.restrictions.getPolicy).toHaveBeenCalledTimes(1);
  });

  it("switch OFF + BUYER_PORTAL: planned, so the choke point judges the buyer's add", async () => {
    const plan = await planOrderEditRestrictions(deps(false), args("BUYER_PORTAL"));
    // an add with no resolvable size is always checked (fail closed): the line carries only its product
    expect(plan?.lines).toEqual([{ productId: "p1" }]);
  });

  it("switch ON + STAFF: planned", async () => {
    expect(await planOrderEditRestrictions(deps(true), args("STAFF"))).not.toBeNull();
  });
});

describe("planChangeRequestRestrictions: the switch is staff-channel only", () => {
  const deps = (enabled: boolean) => ({
    restrictions: { getPolicy: jest.fn().mockResolvedValue(policy(enabled)) },
  });
  const args = (channel: "STAFF" | "BUYER_PORTAL") => ({
    tenantId: T,
    existing: [],
    cr: { type: "ADD_ITEM", productId: "p1" },
    principal: who(channel),
  });

  it("switch OFF + STAFF: no plan", async () => {
    expect(await planChangeRequestRestrictions(deps(false), args("STAFF"))).toBeNull();
  });

  it("switch OFF + BUYER_PORTAL: planned", async () => {
    const plan = await planChangeRequestRestrictions(deps(false), args("BUYER_PORTAL"));
    expect(plan?.lines).toEqual([{ productId: "p1" }]);
  });
});
