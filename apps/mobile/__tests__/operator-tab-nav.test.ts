/**
 * Pressing a tab must return that tab to its root, not restore the sub-screen
 * you were last on. The bar now lives outside the tab navigator, so instead of a
 * `tabPress` listener it locates the tab's nested stack and pops it directly.
 * findDeepTabStackKey is the lookup — it must return a key ONLY when there is
 * something to pop, or we dispatch pointless actions on every press.
 */
import { findDeepTabStackKey } from "../lib/operator-tab-nav";

/** Mirrors the real shape: __root stack → (operator) stack → (tabs) tab nav. */
const rootStateWith = (tabRoutes: Array<{ name: string; state?: unknown }>) => ({
  type: "stack",
  index: 0,
  key: "root-1",
  routes: [
    {
      name: "(operator)",
      state: {
        type: "stack",
        index: 0,
        key: "operator-1",
        routes: [
          {
            name: "(tabs)",
            state: { type: "tab", index: 0, key: "tabs-1", routes: tabRoutes },
          },
        ],
      },
    },
  ],
});

describe("findDeepTabStackKey", () => {
  it("returns the nested stack key when the tab is deeper than its root", () => {
    const state = rootStateWith([
      { name: "home" },
      { name: "orders", state: { type: "stack", index: 2, key: "orders-stack", routes: [] } },
    ]);
    expect(findDeepTabStackKey(state, "orders")).toBe("orders-stack");
  });

  it("returns null when the tab is already at its root", () => {
    const state = rootStateWith([
      { name: "orders", state: { type: "stack", index: 0, key: "orders-stack", routes: [] } },
    ]);
    expect(findDeepTabStackKey(state, "orders")).toBeNull();
  });

  it("returns null for a tab that was never visited", () => {
    // Tab screens are lazy, so an unvisited route carries no `state` at all.
    const state = rootStateWith([{ name: "home" }, { name: "orders" }]);
    expect(findDeepTabStackKey(state, "orders")).toBeNull();
  });

  it("returns null for a leaf tab with no nested navigator", () => {
    const state = rootStateWith([{ name: "home" }]);
    expect(findDeepTabStackKey(state, "home")).toBeNull();
  });

  it("finds the tab navigator however deeply it is nested", () => {
    const state = rootStateWith([
      { name: "orders", state: { type: "stack", index: 1, key: "orders-stack", routes: [] } },
    ]);
    expect(findDeepTabStackKey(state, "orders")).toBe("orders-stack");
  });

  it("returns null when no tab navigator is mounted (deep-link / cold start)", () => {
    const state = {
      type: "stack",
      index: 0,
      key: "root-1",
      routes: [
        {
          name: "(operator)",
          state: {
            type: "stack",
            index: 0,
            key: "operator-1",
            routes: [{ name: "credit-notes" }],
          },
        },
      ],
    };
    expect(findDeepTabStackKey(state, "orders")).toBeNull();
  });

  it("returns null for an unknown tab name", () => {
    const state = rootStateWith([
      { name: "orders", state: { type: "stack", index: 2, key: "orders-stack", routes: [] } },
    ]);
    expect(findDeepTabStackKey(state, "nope")).toBeNull();
  });

  it("does not throw on missing or malformed state", () => {
    expect(findDeepTabStackKey(undefined, "orders")).toBeNull();
    expect(findDeepTabStackKey(null, "orders")).toBeNull();
    expect(findDeepTabStackKey({}, "orders")).toBeNull();
  });
});
