import {
  COUNTER_PATH,
  isRegisterPath,
  isSafeExitPath,
  readExitTarget,
  recordPreviousPath,
} from "./register-mode";

/** POS-7: the route-derived register flag and the previous-path tracker behind "Exit counter". */

afterEach(() => {
  jest.restoreAllMocks();
  sessionStorage.clear();
});

describe("isRegisterPath", () => {
  it("is true only on /orders/counter-sale", () => {
    expect(COUNTER_PATH).toBe("/orders/counter-sale");
    expect(isRegisterPath("/orders/counter-sale")).toBe(true);
    expect(isRegisterPath("/orders/counter-sale/")).toBe(true);
  });

  it("is false everywhere else, including look-alikes and empty values", () => {
    for (const p of [
      "/orders",
      "/orders/counter-sale-history",
      "/orders/counter-sale/x",
      "/orders/abc",
      "/dashboard",
      "/",
      "",
      null,
      undefined,
    ]) {
      expect(isRegisterPath(p as string)).toBe(false);
    }
  });
});

describe("isSafeExitPath", () => {
  it("accepts same-origin internal paths", () => {
    for (const p of ["/dashboard", "/orders", "/customers/abc?tab=1", "/orders/abc#x"]) {
      expect(isSafeExitPath(p)).toBe(true);
    }
  });

  it("rejects the counter, protocols, protocol-relative, backslash and non-string values", () => {
    for (const p of [
      "/orders/counter-sale",
      "/orders/counter-sale?x=1",
      "/orders/counter-sale/",
      "https://evil.example/x",
      "javascript:alert(1)",
      "//evil.example/x",
      "/\\evil.example",
      "orders",
      "",
      " /orders",
      "/orders\nx",
      null,
      undefined,
      42,
    ]) {
      expect(isSafeExitPath(p)).toBe(false);
    }
  });
});

describe("previous-path tracker", () => {
  it("records the last non-counter path and exits there", () => {
    recordPreviousPath("/customers");
    recordPreviousPath("/invoices");
    expect(readExitTarget()).toBe("/invoices");
  });

  it("never records the counter itself", () => {
    recordPreviousPath("/invoices");
    recordPreviousPath("/orders/counter-sale");
    expect(readExitTarget()).toBe("/invoices");
  });

  it("falls back to /dashboard with nothing recorded", () => {
    expect(readExitTarget()).toBe("/dashboard");
  });

  it("falls back to /dashboard when the stored value is unsafe", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/orders/counter-sale", "x"]) {
      sessionStorage.setItem("rf-register-prev", bad);
      expect(readExitTarget()).toBe("/dashboard");
    }
  });

  it("does not throw and falls back when sessionStorage throws", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => recordPreviousPath("/invoices")).not.toThrow();
    expect(readExitTarget()).toBe("/dashboard");
  });
});
