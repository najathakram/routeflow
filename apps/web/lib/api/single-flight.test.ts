import { singleFlight } from "./single-flight";

/** B1379: a second identical call while the first is still on its way must not send anything. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("the same arguments twice before the first settles: one call, the same promise", async () => {
    const d = deferred<string>();
    const fn = jest.fn((_: { productId: string; quantity: number }) => d.promise);
    const guarded = singleFlight(fn);
    const first = guarded({ productId: "p1", quantity: 1 });
    const second = guarded({ productId: "p1", quantity: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    d.resolve("ok");
    await expect(second).resolves.toBe("ok");
  });

  it("different arguments are a different action and go through", () => {
    const fn = jest.fn((_: { productId: string; quantity: number }) => new Promise(() => {}));
    const guarded = singleFlight(fn);
    void guarded({ productId: "p1", quantity: 1 });
    void guarded({ productId: "p1", quantity: 2 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("once the first has settled, the same arguments are sent again (a deliberate second adjustment)", async () => {
    const fn = jest.fn((_: { quantity: number }) => Promise.resolve("ok"));
    const guarded = singleFlight(fn);
    await guarded({ quantity: 1 });
    await guarded({ quantity: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a failed call does not block a retry, and both waiting callers see the failure", async () => {
    const d = deferred<string>();
    const fn = jest.fn((_: { quantity: number }) => d.promise);
    const guarded = singleFlight(fn);
    const first = guarded({ quantity: 1 });
    const second = guarded({ quantity: 1 });
    d.reject(new Error("offline"));
    await expect(first).rejects.toThrow("offline");
    await expect(second).rejects.toThrow("offline");
    void guarded({ quantity: 1 }).catch(() => {});
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
