import { renderHook, act } from "@testing-library/react";
import { useSortableData } from "./use-sortable-data";

interface Row {
  name: string;
}

// The pre-change default comparator, kept here as the reference for ordering.
const oldCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

const NAMES = [
  "banana",
  "Apple",
  "apple",
  "Éclair",
  "eclair",
  "Zebra",
  "item 10",
  "item 2",
  "Item 1",
  "côte",
  "cote",
  "Cola 330ml",
  "cola 1l",
  "résumé",
  "Resume",
];

describe("useSortableData default string order", () => {
  it.each(["asc", "desc"] as const)("matches the old localeCompare order (%s)", (dir) => {
    const rows: Row[] = NAMES.map((name) => ({ name }));
    const { result } = renderHook(() => useSortableData(rows, { defaultKey: "name" }));
    if (dir === "desc") act(() => result.current.setSort("name", "desc"));
    const expected = rows
      .map((row, idx) => ({ row, idx }))
      .sort((a, b) => {
        const c = oldCompare(a.row.name, b.row.name);
        return c !== 0 ? (dir === "asc" ? c : -c) : a.idx - b.idx;
      })
      .map((x) => x.row.name);
    expect(result.current.sorted.map((r) => r.name)).toEqual(expected);
  });

  it("does not re-sort when re-rendered with the same data and stable comparators", () => {
    const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
    let calls = 0;
    const comparators = {
      n: (a: { n: number }, b: { n: number }) => {
        calls += 1;
        return a.n - b.n;
      },
    };
    const { result, rerender } = renderHook(() =>
      useSortableData(rows, { defaultKey: "n", comparators }),
    );
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    const first = result.current.sorted;
    rerender();
    rerender();
    expect(calls).toBe(afterFirst);
    expect(result.current.sorted).toBe(first);
  });
});
