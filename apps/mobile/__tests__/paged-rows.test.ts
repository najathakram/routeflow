import { flattenPages, mergeProductIndex } from "../lib/paged-rows";

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe("flattenPages", () => {
  it("returns [] for no pages", () => {
    expect(flattenPages(undefined)).toEqual([]);
    expect(flattenPages([])).toEqual([]);
  });

  it("flattens pages in order", () => {
    const out = flattenPages([{ data: [row("a"), row("b")] }, { data: [row("c")] }]);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("de-dupes a row re-emitted at a page boundary", () => {
    // Offset pagination re-emits when the underlying set shifts mid-scroll.
    // Duplicate keys crash FlatList, so this is not cosmetic.
    const out = flattenPages([{ data: [row("a"), row("b")] }, { data: [row("b"), row("c")] }]);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the FIRST copy of a duplicate", () => {
    const out = flattenPages([{ data: [row("a", { n: 1 })] }, { data: [row("a", { n: 2 })] }]);
    expect(out).toEqual([{ id: "a", n: 1 }]);
  });

  it("tolerates a page with no data and rows with no id", () => {
    const out = flattenPages([{ data: undefined as any }, { data: [row(""), row("a")] }]);
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("mergeProductIndex", () => {
  it("indexes the current page", () => {
    const index = mergeProductIndex([row("a"), row("b")], {});
    expect([...index.keys()].sort()).toEqual(["a", "b"]);
  });

  it("keeps a snapshot the current page no longer contains", () => {
    // The direct guard for the tapped-line-drops-out bug: add a line, then
    // search, and the page it came from is gone. Without the snapshot the
    // footer total silently under-reports.
    const index = mergeProductIndex([row("b")], { a: row("a", { name: "Widget" }) });
    expect(index.get("a")).toEqual({ id: "a", name: "Widget" });
    expect(index.get("b")).toEqual({ id: "b" });
  });

  it("prefers the live page row over a stale snapshot of the same id", () => {
    const index = mergeProductIndex([row("a", { price: 5 })], { a: row("a", { price: 99 }) });
    expect(index.get("a")).toEqual({ id: "a", price: 5 });
  });

  it("handles both sides being empty", () => {
    expect(mergeProductIndex([], {}).size).toBe(0);
  });
});
