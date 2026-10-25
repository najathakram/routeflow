/**
 * SA-740r2 item 6 / SA-750r3: the refund paths take the day-close lock around their write. The close takes the EXCLUSIVE form
 * of `(hashtext('counter-close'), hashtext(tenantId || ':' || registerKey))`; the tender, the pickup and the refunds take the
 * SHARED form, so a close waits for the writes in flight (a refund's `refundedAt` is the app clock, and a refund committed after
 * the cutoff but stamped before it would be lost from the day) while refunds never serialize with each other.
 */
import {
  COUNTER_DEFAULT_REGISTER,
  counterCloseKeyOf,
  dbClockNow,
  lockCounterClose,
  registerKeyOfOrder,
  tillRegisterOfSale,
} from "./counter-close-lock";

describe("dbClockNow: refundedAt comes from the database clock", () => {
  it("reads clock_timestamp() on the caller's transaction and returns that instant", async () => {
    const at = new Date("2026-10-08T20:00:00.123Z");
    const seen: string[] = [];
    const tx = {
      $queryRaw: (strings: TemplateStringsArray) => {
        seen.push(strings.join("?").replace(/\s+/g, " ").trim());
        return Promise.resolve([{ now: at }]);
      },
    };
    expect(await dbClockNow(tx)).toEqual(at);
    expect(seen).toEqual(["SELECT clock_timestamp() AS now"]);
  });
});

describe("counter-close lock helpers", () => {
  it("the default register is main, and the key is tenantId:registerKey", () => {
    expect(COUNTER_DEFAULT_REGISTER).toBe("main");
    expect(counterCloseKeyOf("t1", "main")).toBe("t1:main");
    expect(counterCloseKeyOf("t1", "b")).toBe("t1:b");
  });

  it("only a counter order has a register: Order.registerKey ?? the default; any other order has none (no lock)", () => {
    expect(registerKeyOfOrder({ counterSale: true, registerKey: null })).toBe("main");
    expect(registerKeyOfOrder({ counterSale: true, registerKey: undefined })).toBe("main");
    expect(registerKeyOfOrder({ counterSale: true, registerKey: "b" })).toBe("b");
    expect(registerKeyOfOrder({ counterSale: false, registerKey: "b" })).toBeNull();
    expect(registerKeyOfOrder({})).toBeNull();
    expect(registerKeyOfOrder(null)).toBeNull();
  });

  it("W-829 / SA-932 F: tillRegisterOfSale also covers a Store pickup hand-over with a stamped register", () => {
    // a counter order: the same answer as registerKeyOfOrder
    expect(tillRegisterOfSale({ counterSale: true, registerKey: null })).toBe("main");
    expect(tillRegisterOfSale({ counterSale: true, registerKey: "b", fulfillPath: "ROUTE" })).toBe(
      "b",
    );
    // a non-counter PICKUP order whose hand-over stamped a register is a till sale on that register
    expect(
      tillRegisterOfSale({ counterSale: false, fulfillPath: "PICKUP", registerKey: "till-2" }),
    ).toBe("till-2");
    // a pickup that was never handed over at a till (no stamp) is not a till event
    expect(
      tillRegisterOfSale({ counterSale: false, fulfillPath: "PICKUP", registerKey: null }),
    ).toBeNull();
    // only PICKUP counts: a stamped key on a route or carrier order is not the till's
    expect(
      tillRegisterOfSale({ counterSale: false, fulfillPath: "ROUTE", registerKey: "b" }),
    ).toBeNull();
    expect(
      tillRegisterOfSale({ counterSale: false, fulfillPath: "SHIP", registerKey: "b" }),
    ).toBeNull();
    expect(tillRegisterOfSale({ counterSale: false, registerKey: "b" })).toBeNull();
    expect(tillRegisterOfSale({})).toBeNull();
    expect(tillRegisterOfSale(null)).toBeNull();
    // registerKeyOfOrder keeps its counter-only meaning (the void and the tender window read it)
    expect(registerKeyOfOrder({ counterSale: false, registerKey: "till-2" })).toBeNull();
  });

  it("lockCounterClose runs the SHARED transaction-scoped advisory lock on the (counter-close, tenant:register) key", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const tx = {
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
        return Promise.resolve(0);
      },
    };
    await lockCounterClose(tx, "t1", "main");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(
      "SELECT pg_advisory_xact_lock_shared(hashtext('counter-close'), hashtext(?))",
    );
    expect(calls[0].values).toEqual(["t1:main"]);
  });
});
