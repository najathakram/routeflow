import { readWindowFacts, countSalesSince } from "./day-close-facts";
import { registerOrderWhere, parseRegisterKey, REGISTER_KEY_PATTERN } from "./day-close-register";

/**
 * The window's queries are the Today's-sales where-builders with the register filter AND-ed on the order, and every where names
 * the tenant. The real filtering is pinned against Postgres by day-close.db.spec.ts; this pins what is SENT.
 */
const window = {
  start: new Date("2026-10-08T04:00:00.000Z"),
  end: new Date("2026-10-09T02:00:00.000Z"),
};

function recorder() {
  const calls: Array<{ model: string; method: string; args: any }> = [];
  const model = (name: string, result: unknown) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (args: any) => {
          calls.push({ model: name, method, args });
          return result;
        },
      },
    );
  const db = {
    order: model("order", { _count: { _all: 0 }, _sum: { total: null } }),
    invoicePayment: model("invoicePayment", []),
    creditNote: model("creditNote", [{ id: "cn-1" }]),
    return: model("return", []),
  };
  return { db: db as never, calls };
}

describe("registerOrderWhere", () => {
  it("the default register also reads the orders that carry no key (COALESCE(registerKey, 'main'))", () => {
    expect(registerOrderWhere("main")).toEqual({
      OR: [{ registerKey: "main" }, { registerKey: null }],
    });
  });
  it("another register reads only its own key: it can never count 'main' cash", () => {
    expect(registerOrderWhere("b")).toEqual({ registerKey: "b" });
  });
});

describe("parseRegisterKey", () => {
  it("defaults to main; accepts the key shapes; refuses the rest with a 400", () => {
    expect(parseRegisterKey(undefined)).toBe("main");
    expect(parseRegisterKey("")).toBe("main");
    expect(parseRegisterKey("b")).toBe("b");
    expect(parseRegisterKey("driver:9f1")).toBe("driver:9f1");
    for (const bad of ["a b", "-x", "x".repeat(65), "a;drop", 5]) {
      expect(() => parseRegisterKey(bad)).toThrow(/registerKey/);
    }
    expect(REGISTER_KEY_PATTERN.test("main")).toBe(true);
  });
});

describe("readWindowFacts: what is sent", () => {
  it("scopes every query to the tenant and the register, over the one window", async () => {
    const { db, calls } = recorder();
    await readWindowFacts(db, "t-acme", "b", window);
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual([
      "order.aggregate",
      "invoicePayment.findMany",
      "invoicePayment.aggregate",
      "creditNote.findMany",
      "return.findMany",
    ]);
    const json = (i: number) => JSON.stringify(calls[i].args.where);
    // sales
    expect(json(0)).toContain('"tenantId":"t-acme"');
    expect(json(0)).toContain('"registerKey":"b"');
    expect(json(0)).toContain('"counterSale":true');
    // money in: PAID, by paid date, on the register's orders
    expect(json(1)).toContain('"status":"PAID"');
    expect(json(1)).toContain('"paidAt"');
    expect(json(1)).toContain('"registerKey":"b"');
    expect(calls[1].args.where.AND[0].paidAt).toEqual({ gte: window.start, lt: window.end });
    // on account
    expect(json(2)).toContain('"registerKey":"b"');
    // credit notes: ids only, no register (a credit note has none)
    expect(json(3)).toContain('"tenantId":"t-acme"');
    // returns: dated by when they were resolved, on the register's orders, with the credit note ids found above
    expect(json(4)).toContain('"registerKey":"b"');
    expect(json(4)).toContain('"cn-1"');
    expect(json(4)).toContain('"tenantId":"t-acme"');
  });

  it("the default register is matched with the null-key fallback on every query that reads orders", async () => {
    const { db, calls } = recorder();
    await readWindowFacts(db, "t-acme", "main", window);
    for (const i of [0, 1, 2, 4]) {
      expect(JSON.stringify(calls[i].args.where)).toContain(
        '"OR":[{"registerKey":"main"},{"registerKey":null}]',
      );
    }
  });

  it("reads the payment fields the till-cash predicate needs, and the invoice's order id", async () => {
    const { db, calls } = recorder();
    await readWindowFacts(db, "t-acme", "main", window);
    expect(calls[1].args.select).toEqual({
      amount: true,
      method: true,
      status: true,
      paymentGroupId: true,
      checkStatus: true,
      invoice: { select: { orderId: true } },
    });
  });

  it("countSalesSince counts live counter sales of the register from the cutoff on", async () => {
    const { db, calls } = recorder();
    await countSalesSince(db, "t-acme", "main", window.start, window.end);
    const where = calls[0].args.where;
    expect(JSON.stringify(where)).toContain('"tenantId":"t-acme"');
    expect(where.AND[0].createdAt).toEqual({ gte: window.start, lt: window.end });
  });
});
