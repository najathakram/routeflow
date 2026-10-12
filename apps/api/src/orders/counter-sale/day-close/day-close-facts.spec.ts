import { readWindowFacts, countSalesSince } from "./day-close-facts";
import { foldDayClose } from "./day-close-fold";
import { pickupTenderGroupId } from "../pickup-tender-group";
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
    expect(parseRegisterKey("-x")).toBe("-x"); // the union with the park / quick-key pattern
    for (const bad of ["a b", ":x", "x".repeat(65), "a;drop", 5]) {
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
      "invoicePayment.findMany", // the POS-mode pickup hand-over candidates
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
    // hand-over candidates: PAID, by paid date, grouped, on NON-counter PICKUP orders of the register
    expect(json(2)).toContain('"tenantId":"t-acme"');
    expect(json(2)).toContain('"status":"PAID"');
    expect(json(2)).toContain('"paymentGroupId":{"not":null}');
    expect(json(2)).toContain('"counterSale":false');
    expect(json(2)).toContain('"fulfillPath":"PICKUP"');
    expect(json(2)).toContain('"registerKey":"b"');
    expect(calls[2].args.where.AND[0].paidAt).toEqual({ gte: window.start, lt: window.end });
    // on account
    expect(json(3)).toContain('"registerKey":"b"');
    // credit notes: ids only, no register (a credit note has none)
    expect(json(4)).toContain('"tenantId":"t-acme"');
    // returns: dated by when they were resolved, on the register's orders, with the credit note ids found above
    expect(json(5)).toContain('"registerKey":"b"');
    expect(json(5)).toContain('"cn-1"');
    expect(json(5)).toContain('"tenantId":"t-acme"');
  });

  it("money in keeps the cash of an invoice written off later: only a VOID invoice drops its payments", async () => {
    const { db, calls } = recorder();
    await readWindowFacts(db, "t-acme", "main", window);
    const where = JSON.stringify(calls[1].args.where);
    expect(where).toContain('"status":{"not":"VOID"}');
    expect(where).not.toContain("WRITTEN_OFF");
    // the hand-over rows follow the same rule (the close's, not Today's sales')
    const handOver = JSON.stringify(calls[2].args.where);
    expect(handOver).toContain('"status":{"not":"VOID"}');
    expect(handOver).not.toContain("WRITTEN_OFF");
  });

  it("the default register is matched with the null-key fallback on every query that reads orders", async () => {
    const { db, calls } = recorder();
    await readWindowFacts(db, "t-acme", "main", window);
    for (const i of [0, 1, 2, 3, 5]) {
      expect(JSON.stringify(calls[i].args.where)).toContain(
        '"OR":[{"registerKey":"main"},{"registerKey":null}]',
      );
    }
  });

  it("reads the payment fields the till-cash predicate needs, and the invoice's order id", async () => {
    const { db, calls } = recorder();
    await readWindowFacts(db, "t-acme", "main", window);
    const select = {
      amount: true,
      method: true,
      status: true,
      paymentGroupId: true,
      checkStatus: true,
      invoice: { select: { orderId: true, order: { select: { counterSale: true } } } },
    };
    expect(calls[1].args.select).toEqual(select);
    expect(calls[2].args.select).toEqual(select);
  });

  it("countSalesSince counts live counter sales of the register from the cutoff on", async () => {
    const { db, calls } = recorder();
    await countSalesSince(db, "t-acme", "main", window.start, window.end);
    const where = calls[0].args.where;
    expect(JSON.stringify(where)).toContain('"tenantId":"t-acme"');
    expect(where.AND[0].createdAt).toEqual({ gte: window.start, lt: window.end });
  });
});

/** SA-750r3 r-note (Train 4 meets day close): the hand-over rows are matched on the v5 group id in code, then folded as till money. */
describe("readWindowFacts: POS-mode pickup hand-overs", () => {
  const row = (
    orderId: string,
    paymentGroupId: string | null,
    amount: number,
    counterSale = false,
  ) => ({
    amount,
    method: "CASH",
    status: "PAID",
    paymentGroupId,
    checkStatus: null,
    invoice: { orderId, order: { counterSale } },
  });
  function db(counter: unknown[], candidates: unknown[]) {
    let n = 0;
    return {
      order: { aggregate: async () => ({ _count: { _all: 0 }, _sum: { total: null } }) },
      invoicePayment: {
        findMany: async () => (n++ === 0 ? counter : candidates),
        aggregate: async () => ({ _sum: { amount: null } }),
      },
      creditNote: { findMany: async () => [] },
      return: { findMany: async () => [] },
    } as never;
  }

  it("keeps only the candidates whose group id IS pickupTenderGroupId(orderId); the rest never enter the facts", async () => {
    const facts = await readWindowFacts(
      db(
        [row("o-sale", null, 30, true)],
        [
          row("o-pickup", pickupTenderGroupId("o-pickup"), 20),
          row("o-delivery", "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11", 40), // a driver's group
          row("o-pickup-2", pickupTenderGroupId("o-pickup"), 7), // another order's id
        ],
      ),
      "t-acme",
      "main",
      window,
    );
    expect(facts.payments.map((p) => [p.invoice?.orderId, p.amount])).toEqual([
      ["o-sale", 30],
      ["o-pickup", 20],
    ]);
    const fold = foldDayClose(facts);
    expect(fold.tillCash).toBe(50);
    expect(fold.totals.notAtTill).toBe(0);
  });

  it("countSalesSince is unchanged: a hand-over is not a counter sale", async () => {
    const { db: rec, calls } = recorder();
    await countSalesSince(rec, "t-acme", "main", window.start, window.end);
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["order.count"]);
    expect(JSON.stringify(calls[0].args.where)).toContain('"counterSale":true');
  });
});

/**
 * CONSERVATION (row 342 review): every payment row the window reads lands in exactly one Z bucket, and the buckets add up to
 * the window total. A POS hand-over whose check was deposited the same day is read (selected by its own pickup group) and folds
 * to `notAtTill`; it must never vanish from every bucket. Which bucket is RIGHT for it is an open SA question: this pins that it
 * has one, and that master's bucket (notAtTill) is the one it has today.
 */
describe("day close conservation: no payment row falls out of the buckets", () => {
  const pay = (
    orderId: string,
    over: {
      method?: string;
      amount: number;
      group?: string | null;
      checkStatus?: string | null;
      counterSale?: boolean;
    },
  ) => ({
    amount: over.amount,
    method: over.method ?? "CASH",
    status: "PAID",
    paymentGroupId: over.group === undefined ? null : over.group,
    checkStatus: over.checkStatus ?? null,
    invoice: { orderId, order: { counterSale: over.counterSale ?? false } },
  });
  function dbOf(counter: unknown[], candidates: unknown[]) {
    let n = 0;
    return {
      order: { aggregate: async () => ({ _count: { _all: 0 }, _sum: { total: null } }) },
      invoicePayment: {
        findMany: async () => (n++ === 0 ? counter : candidates),
        aggregate: async () => ({ _sum: { amount: null } }),
      },
      creditNote: { findMany: async () => [] },
      return: { findMany: async () => [] },
    } as never;
  }

  it("a same-day DEPOSITED hand-over check folds to notAtTill, not to nothing; the buckets sum to the window total", async () => {
    const counter = [
      pay("o-c1", { amount: 30, counterSale: true }), // till cash
      pay("o-c2", { amount: 12, method: "CREDIT_CARD", counterSale: true }), // card
      pay("o-c3", { amount: 7, group: "5b0f4a6e-2b0a-4c53-9a54-6f1c8d1f2a11", counterSale: true }), // an office payment: notAtTill
      pay("o-c4", { amount: 9, method: "CREDIT_NOTE", counterSale: true }), // a credit application
    ];
    const candidates = [
      pay("o-p1", { amount: 20, group: pickupTenderGroupId("o-p1") }), // hand-over cash: till
      pay("o-p2", {
        amount: 40,
        method: "CHECK",
        checkStatus: "DEPOSITED",
        group: pickupTenderGroupId("o-p2"),
      }),
      pay("o-p3", {
        amount: 15,
        method: "CHECK",
        checkStatus: "RECORDED",
        group: pickupTenderGroupId("o-p3"),
      }),
    ];
    const facts = await readWindowFacts(dbOf(counter, candidates), "t-acme", "main", window);
    // every counter row and every hand-over row (selected by its own pickup group) reaches the fold
    expect(facts.payments).toHaveLength(counter.length + candidates.length);
    const fold = foldDayClose(facts);
    const total = [...counter, ...candidates].reduce((s, p) => s + Number(p.amount), 0);
    const buckets = fold.totals.moneyIn.total + fold.totals.notAtTill + fold.totals.storeCreditUsed;
    expect(buckets).toBe(total); // 30 + 12 + 20 + 15 (money in) + 7 + 40 (notAtTill) + 9 (store credit) = 133
    expect(fold.totals.notAtTill).toBe(47); // the office payment 7 and the deposited check 40
    expect(fold.totals.moneyIn).toMatchObject({ cash: 50, card: 12, check: 15, total: 77 });
    expect(fold.totals.handOver).toEqual({ count: 2, cash: 20 });
  });
});
