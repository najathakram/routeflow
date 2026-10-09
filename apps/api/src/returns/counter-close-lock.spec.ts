/**
 * SA-740r2 item 6 / SA-750r3: the refund paths take the day-close lock around their write. The close takes the EXCLUSIVE form
 * of `(hashtext('counter-close'), hashtext(tenantId || ':' || registerKey))`; the tender, the pickup and the refunds take the
 * SHARED form, so a close waits for the writes in flight (a refund's `refundedAt` is the app clock, and a refund committed after
 * the cutoff but stamped before it would be lost from the day) while refunds never serialize with each other.
 */
import {
  COUNTER_DEFAULT_REGISTER,
  counterCloseKeyOf,
  lockCounterClose,
  registerKeyOfOrder,
} from "./counter-close-lock";

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
