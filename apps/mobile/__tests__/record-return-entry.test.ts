import { readFileSync } from "fs";
import { join } from "path";

// #2420 review (required fold): nothing navigated to /(operator)/returns/inline, so the inline
// return screen was unreachable. Mobile now carries web's RecordReturnAction entry points — order
// detail (customer + order) and customer detail (customer only) — hidden without the
// orders_inline_returns add-on and never gated on the order's status.

const push = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
let addon = { enabled: true, resolved: true };
jest.mock("../lib/api/addons", () => ({ useInlineReturnsAddon: () => addon }));

import { inlineReturnHref } from "../lib/inline-return-screen";
import { useRecordReturn } from "../hooks/useRecordReturn";

beforeEach(() => {
  push.mockReset();
  addon = { enabled: true, resolved: true };
});

describe("inlineReturnHref", () => {
  it("order detail: customer + order + name", () => {
    expect(inlineReturnHref({ customerId: "c1", orderId: "o1", customerName: "Acme" })).toEqual({
      pathname: "/(operator)/returns/inline",
      params: { customerId: "c1", orderId: "o1", customerName: "Acme" },
    });
  });
  it("customer detail: no order param at all", () => {
    expect(inlineReturnHref({ customerId: "c1", customerName: null })).toEqual({
      pathname: "/(operator)/returns/inline",
      params: { customerId: "c1" },
    });
  });
});

describe("useRecordReturn", () => {
  it("allowed + a customer: the handler opens the inline return screen", () => {
    const open = useRecordReturn({ customerId: "c1", orderId: "o1", customerName: "Acme" });
    expect(open).not.toBeNull();
    open!();
    expect(push).toHaveBeenCalledWith({
      pathname: "/(operator)/returns/inline",
      params: { customerId: "c1", orderId: "o1", customerName: "Acme" },
    });
  });
  it.each([
    ["add-on still loading", { enabled: false, resolved: false }],
    ["add-on not on the plan", { enabled: false, resolved: true }],
  ])("%s: no entry point", (_n, state) => {
    addon = state;
    expect(useRecordReturn({ customerId: "c1" })).toBeNull();
  });
  it("no customer yet (order still loading): no entry point", () => {
    expect(useRecordReturn({ customerId: undefined })).toBeNull();
  });
});

describe("both screens mount the entry point (source pins)", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  it.each([
    ["order detail", "app/(operator)/(tabs)/orders/[id].tsx", "if (isLoading) {"],
    ["customer detail", "app/(operator)/customers/[id].tsx", "if (isLoading || !customer) {"],
  ])(
    "%s calls useRecordReturn BEFORE its early return and renders 'Record return'",
    (_n, rel, early) => {
      const src = read(rel);
      const hookAt = src.indexOf("useRecordReturn({");
      expect(hookAt).toBeGreaterThan(-1);
      expect(hookAt).toBeLessThan(src.indexOf(early));
      expect(src).toMatch(/\{recordReturn \? \([\s\S]{0,400}?Record return/);
    },
  );
  it("order detail's entry is NOT inside an order-status condition", () => {
    const src = read("app/(operator)/(tabs)/orders/[id].tsx");
    const at = src.indexOf("{recordReturn ? (");
    const before = src.slice(Math.max(0, at - 200), at);
    expect(before).not.toMatch(/order\.status/);
  });
});
