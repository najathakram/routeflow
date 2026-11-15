import { act, renderHook } from "@testing-library/react";
import { OPERATOR_NAV } from "./nav-config";
import { useOpenNavGroups } from "./use-open-nav-groups";

beforeEach(() => localStorage.clear());

const setup = (mode: "multi" | "single", pathname = "/dashboard", userId: string | null = "u1") =>
  renderHook(
    (p: { pathname: string }) =>
      useOpenNavGroups({ nav: OPERATOR_NAV, pathname: p.pathname, userId, mode }),
    { initialProps: { pathname } },
  );

describe("useOpenNavGroups", () => {
  it("multi: groups the person opened stay open when they navigate elsewhere", () => {
    const h = setup("multi", "/dashboard");
    act(() => h.result.current.toggle("Orders"));
    act(() => h.result.current.toggle("Finance"));
    expect(h.result.current.isOpen("Orders")).toBe(true);
    expect(h.result.current.isOpen("Finance")).toBe(true);
    h.rerender({ pathname: "/customers" });
    expect(h.result.current.isOpen("Orders")).toBe(true);
    expect(h.result.current.isOpen("Finance")).toBe(true);
  });

  it("multi: navigating into a group opens it and keeps the others", () => {
    const h = setup("multi", "/dashboard");
    act(() => h.result.current.toggle("Finance"));
    h.rerender({ pathname: "/orders" });
    expect(h.result.current.isOpen("Orders")).toBe(true);
    expect(h.result.current.isOpen("Finance")).toBe(true);
  });

  it("multi: remembers the set per user on this device", () => {
    const a = setup("multi", "/customers", "u1");
    act(() => a.result.current.toggle("Orders"));
    act(() => a.result.current.toggle("Finance"));
    a.unmount();
    expect(JSON.parse(localStorage.getItem("rf-nav-open:u1") ?? "null")).toEqual([
      "Warehouse",
      "Orders",
      "Finance",
    ]);
    const again = setup("multi", "/customers", "u1");
    expect(again.result.current.isOpen("Orders")).toBe(true);
    expect(again.result.current.isOpen("Finance")).toBe(true);
    const other = setup("multi", "/customers", "u2");
    expect(other.result.current.isOpen("Orders")).toBe(false);
    expect(other.result.current.isOpen("Finance")).toBe(false);
  });

  it("nothing remembered, /dashboard: Warehouse opens (kept first-load pin)", () => {
    const h = setup("multi", "/dashboard");
    expect(h.result.current.isOpen("Warehouse")).toBe(true);
    expect(h.result.current.isOpen("Orders")).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it("single: keeps one group at a time and stores nothing", () => {
    const h = setup("single", "/dashboard");
    act(() => h.result.current.toggle("Orders"));
    act(() => h.result.current.toggle("Finance"));
    expect(h.result.current.isOpen("Orders")).toBe(false);
    expect(h.result.current.isOpen("Finance")).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it("a remembered label with no such group opens nothing extra", () => {
    localStorage.setItem("rf-nav-open:u1", JSON.stringify(["Old group"]));
    const h = setup("multi", "/customers");
    for (const e of OPERATOR_NAV)
      if (e.kind === "group") expect(h.result.current.isOpen(e.label)).toBe(false);
  });

  it("a malformed stored value reads as nothing remembered", () => {
    localStorage.setItem("rf-nav-open:u1", "{not json");
    const h = setup("multi", "/dashboard");
    expect(h.result.current.isOpen("Warehouse")).toBe(true);
  });

  it("a storage failure never throws", () => {
    const spy = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const h = setup("multi", "/dashboard");
    expect(() => act(() => h.result.current.toggle("Orders"))).not.toThrow();
    expect(h.result.current.isOpen("Orders")).toBe(true);
    spy.mockRestore();
  });
});
