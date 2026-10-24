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
    customerId: "c1",
    fulfilmentKind: "DELIVERY" as const,
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
    expect(plan?.params.lines).toEqual([{ productId: "p1", lineKey: expect.any(String) }]);
  });

  it("switch ON + STAFF: planned", async () => {
    expect(await planOrderEditRestrictions(deps(true), args("STAFF"))).not.toBeNull();
  });

  // Row 510 (lead ruling): a DELIBERATE gap, pinned so nobody "fixes" it by accident. The override stamp is carried
  // by the plan's `stamp` step; with the owner-only switch off there is no plan, so a replace-all edit that rewrites a
  // line carrying a stamp writes no stamp on the recreated line. Restrictions are off for the tenant, so there is
  // nothing to acknowledge or evidence; the stamp returns only if the switch is on when the line is next rewritten.
  const STAMPED_LINE = {
    id: "li-1",
    productId: "p1",
    qty: 2,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    status: "PENDING",
    restrictionOverrideReason: "owner approved",
    restrictionOverrideBy: "user-1",
    restrictionOverrideAt: new Date("2026-10-01T00:00:00Z"),
    restrictionOverrideRuleIds: ["rule-1"],
  };
  const rewriteStamped = (channel: "STAFF" | "BUYER_PORTAL") => ({
    ...args(channel),
    existing: [STAMPED_LINE],
    items: [{ productId: "p1", qty: 3 }],
    mode: { kind: "replace" as const, actor: "staff" as const },
  });

  it("flag off: an edit rewriting an override-stamped line does not carry the stamp (deliberate: no plan when restrictions are off)", async () => {
    const plan = await planOrderEditRestrictions(deps(false), rewriteStamped("STAFF"));
    expect(plan).toBeNull(); // no plan, so no `stamp` step runs inside the transaction and nothing re-applies the stamp
  });

  it("flag on (contrast): the same rewrite is planned, so the stamp step exists to carry it", async () => {
    const plan = await planOrderEditRestrictions(deps(true), rewriteStamped("STAFF"));
    expect(plan).not.toBeNull();
    expect(typeof plan?.stamp).toBe("function");
  });
});

describe("planChangeRequestRestrictions: the switch is staff-channel only", () => {
  const deps = (enabled: boolean) => ({
    restrictions: { getPolicy: jest.fn().mockResolvedValue(policy(enabled)) },
  });
  const args = (channel: "STAFF" | "BUYER_PORTAL") => ({
    tenantId: T,
    customerId: "c1",
    fulfilmentKind: "DELIVERY" as const,
    existing: [],
    cr: { id: "cr-1", type: "ADD_ITEM", productId: "p1" },
    principal: who(channel),
  });

  it("switch OFF + STAFF: no plan", async () => {
    expect(await planChangeRequestRestrictions(deps(false), args("STAFF"))).toBeNull();
  });

  it("switch OFF + BUYER_PORTAL: planned", async () => {
    const plan = await planChangeRequestRestrictions(deps(false), args("BUYER_PORTAL"));
    expect(plan?.params.lines).toEqual([{ productId: "p1", lineKey: "cr:cr-1" }]);
  });
});
