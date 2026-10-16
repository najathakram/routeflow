// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOversellOrders, buyer, operator, stockTx, TENANT } from "./testing/oversell-harness";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * SA-606c, extended to the orders.service call sites (order-stock-no-policy-read.spec.ts pins
 * order-stock.ts itself): the policy is read BEFORE the first Order/Product `FOR UPDATE`, never after.
 * A read under row locks holds them across an extra query and can deadlock against the policy write
 * lock. Policy access counts as ANY of: `PolicyOversellReader.read`, the `policyValue` delegate (on
 * the GLOBAL prisma that PolicyService uses AND on the tx), or raw SQL naming PolicyValue.
 *
 * Part 1 (behavioural): create (real order-stock) and edit; part 2: memoised once per request;
 * part 3 (static): orders.service.ts has no resolver / policy call inside a transaction callback.
 */

describe("zero policy reads after the first FOR UPDATE (behavioural)", () => {
  it("create (CUSTOMER, backorder): the policy is read before the product FOR UPDATE, once, and never after", async () => {
    const h = await buildOversellOrders("backorder");
    h.useRealStock();
    const stock = { v: 5 };
    const { prisma } = h;
    (prisma as any).policyValue = { findMany: jest.fn(async () => []), findFirst: jest.fn() };
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        unit: "ea",
        pricePerUnit: 10,
        unitsPerBox: null,
        isActive: true,
        // the buyer gate (#2856) judges these: a fixture that omits them is correctly hidden
        kind: "STANDARD",
        portalVisible: true,
        parent: null,
      },
    ]);
    prisma.order.create.mockResolvedValue({
      id: "o",
      customerId: "cust-1",
      orderNumber: "x",
      total: 0,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "A" },
      lineItems: [],
    });
    const { tx, events } = stockTx(prisma as never, stock);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
    // policy access on the GLOBAL prisma (what PolicyService uses) is logged too
    (prisma.policyValue.findMany as jest.Mock).mockImplementation(async () => {
      events.push("policy-global-delegate");
      return [];
    });
    h.read.mockImplementation(async () => {
      events.push("policy-read");
      return "backorder";
    });

    await h.service.create({ items: [{ productId: "prod-1", qty: 6 }] } as never, buyer as never);

    const firstLock = events.indexOf("for-update");
    expect(firstLock).toBeGreaterThanOrEqual(0);
    const policyAt = events.reduce<number[]>(
      (a, e, i) => (e.startsWith("policy") ? [...a, i] : a),
      [],
    );
    expect(policyAt.length).toBeGreaterThan(0); // RED today: the policy is never read at all
    for (const i of policyAt) expect(i).toBeLessThan(firstLock);
    expect(events.filter((e) => e === "policy-read")).toHaveLength(1); // memoised: ONE read
    expect(events).not.toContain("policy-delegate"); // never the tx delegate
    expect(events).not.toContain("policy-sql");
  });

  it("edit (CUSTOMER): the policy is read before the Order FOR UPDATE and before settleStockForEdit", async () => {
    const h = await buildOversellOrders("backorder");
    const { prisma } = h;
    (prisma as any).policyValue = { findMany: jest.fn(async () => []), findFirst: jest.fn() };
    const line = {
      id: "li-1",
      orderId: "ord-1",
      productId: "prod-1",
      qty: 2,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 5,
      subtotal: 10,
      status: "PENDING",
      priceType: "STANDARD",
      originalPrice: null,
      invoicedQty: 0,
      deliveredQty: 0,
      promoFreeUnits: null,
      unitLabel: null,
      notes: null,
      overrideReason: null,
      position: 0,
    };
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      tenantId: TENANT,
      customerId: "cust-1",
      status: "PENDING",
      routeRun: null,
      shippingFee: 0,
      lineItems: [line],
    });
    prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: null } });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Widget", pricePerUnit: 5, unitsPerBox: null, trackedCategoryId: null },
    ]);
    prisma.deliveryMutation.count.mockResolvedValue(0);
    prisma.orderItem.findMany.mockResolvedValue([line]);

    await h.service.updateOrderItems(
      "ord-1",
      { items: [{ productId: "prod-1", qty: 5 }], replaceAll: true } as never,
      buyer as never,
    );

    const readAt = h.read.mock.invocationCallOrder[0];
    expect(readAt).toBeDefined(); // RED today
    const firstRaw = Math.min(
      ...[prisma.$executeRaw, prisma.$queryRaw].map(
        (m: any) => m.mock.invocationCallOrder[0] ?? Infinity,
      ),
    );
    expect(readAt).toBeLessThan(firstRaw); // before the Order FOR UPDATE
    expect(readAt).toBeLessThan(h.settle.mock.invocationCallOrder[0]);
    expect(h.read).toHaveBeenCalledTimes(1);
    for (const m of [prisma.policyValue.findMany, prisma.policyValue.findFirst]) {
      for (const o of (m as jest.Mock).mock.invocationCallOrder) expect(o).toBeLessThan(firstRaw);
    }
  });

  it("memoised per request, not across requests: one create reads once, a second create reads once more", async () => {
    const h = await buildOversellOrders("off");
    const { prisma } = h;
    (prisma as any).policyValue = { findMany: jest.fn(async () => []), findFirst: jest.fn() };
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        unit: "ea",
        pricePerUnit: 10,
        unitsPerBox: null,
        isActive: true,
        kind: "STANDARD",
        portalVisible: true,
        parent: null,
      },
    ]);
    prisma.order.create.mockResolvedValue({
      id: "o",
      customerId: "cust-1",
      orderNumber: "x",
      total: 0,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "A" },
      lineItems: [],
    });
    const { tx } = stockTx(prisma as never, { v: 50 });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
    const call = () =>
      h.service.create({ items: [{ productId: "prod-1", qty: 1 }] } as never, buyer as never);
    await call();
    expect(h.read).toHaveBeenCalledTimes(1);
    await call();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("a staff request never reads the policy at all", async () => {
    const h = await buildOversellOrders("backorder");
    const { prisma } = h;
    (prisma as any).policyValue = { findMany: jest.fn(async () => []), findFirst: jest.fn() };
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        unit: "ea",
        pricePerUnit: 10,
        unitsPerBox: null,
        isActive: true,
        kind: "STANDARD",
        portalVisible: true,
        parent: null,
      },
    ]);
    prisma.order.create.mockResolvedValue({
      id: "o",
      customerId: "cust-1",
      orderNumber: "x",
      total: 0,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "A" },
      lineItems: [],
    });
    const { tx } = stockTx(prisma as never, { v: 50 });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
    await h.service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] } as never,
      operator as never,
    );
    expect(h.read).not.toHaveBeenCalled();
  });
});

/**
 * Best-effort static scan. Strips comments, finds each `tenantTransaction(` / `$transaction(` call,
 * and returns the text of its argument list (balanced parentheses, string/template aware).
 * LIMITS: no real parser — a callback passed by variable, an aliased transaction helper (e.g.
 * `retryOnTxConflict(..., () => this.prisma.tenantTransaction(` is still found because the inner
 * call is itself matched) or a resolver reached through a private method called from the callback
 * is NOT seen; the behavioural tests above cover those via call order.
 */
export function transactionBodies(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  const re = /(?:tenantTransaction|\$transaction|runEditTx|stockTx)\s*\(/g; // runEditTx / stockTx wrap the tx
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    let quote: string | null = null;
    for (; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    out.push(code.slice(start, i));
  }
  return out;
}

const POLICY_CALL =
  /\bresolveOversellAllowed\s*\(|\boversellReader\b|\bpolicyOversellReader\b|\bpolicies\s*\.|\bPolicyService\b|\bpolicyValue\b/;

describe("static scan: no resolver / policy call inside a transaction callback", () => {
  const file = path.join(__dirname, "orders.service.ts");
  const bodies = transactionBodies(fs.readFileSync(file, "utf8"));

  it("finds the transaction callbacks (the scan is not vacuous)", () => {
    expect(bodies.length).toBeGreaterThan(10);
  });

  it("orders.service.ts: no callback body resolves or reads the policy", () => {
    const offenders = bodies.filter((b) => POLICY_CALL.test(b)).map((b) => b.slice(0, 120));
    expect(offenders).toEqual([]);
  });

  it("self-test: the scan flags a resolver call inside a callback and ignores one outside", () => {
    const bad = `async f(){ await this.prisma.tenantTransaction(async (tx) => { await resolveOversellAllowed(r, a); }); }`;
    const ok = `async f(){ const ok = await resolveOversellAllowed(r, a); await this.prisma.tenantTransaction(async (tx) => { use(ok); }); }`;
    expect(transactionBodies(bad).some((b) => POLICY_CALL.test(b))).toBe(true);
    expect(transactionBodies(ok).some((b) => POLICY_CALL.test(b))).toBe(false);
  });

  it("the same holds for the other two call-site files (order-templates.service.ts)", () => {
    const tpl = fs.readFileSync(
      path.join(__dirname, "..", "order-templates", "order-templates.service.ts"),
      "utf8",
    );
    expect(transactionBodies(tpl).filter((b) => POLICY_CALL.test(b))).toEqual([]);
  });
});
