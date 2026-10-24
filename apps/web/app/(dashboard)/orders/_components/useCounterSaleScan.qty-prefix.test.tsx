import { act, renderHook, waitFor } from "@testing-library/react";
import { resolveProductByCode } from "@/lib/barcode-resolve";
import { useCounterSaleScan } from "./useCounterSaleScan";

/** F01: "2*code" / "2x code" is quantity 2 of that code; a plain number still sets the quantity for the NEXT scan. */
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: jest.fn(),
}));
jest.mock("@/lib/counter-category-search", () => ({
  fetchCategoryPage: jest.fn(),
  findCategoryProducts: jest.fn().mockResolvedValue(null),
}));

const resolve = resolveProductByCode as jest.Mock;
const COLA = { id: "p-cola", name: "Cola 12oz Can", sku: "COLA", isActive: true, unitsPerBox: 24 };

function setup() {
  resolve.mockReset();
  resolve.mockImplementation(async (code: string) =>
    code === "COLA" ? { product: COLA, source: "barcode" } : { notFound: true },
  );
  const add = jest.fn();
  const hook = renderHook(() => useCounterSaleScan({ locked: false, add, refocus: jest.fn() }));
  return { add, hook };
}

describe("the scan box quantity prefix (F01)", () => {
  it.each(["2*COLA", "2x COLA", "2 x COLA", "2X COLA"])("%s adds 2 of COLA", async (typed) => {
    const { add, hook } = setup();
    act(() => hook.result.current.submit(typed));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(resolve).toHaveBeenCalledWith("COLA");
    expect(add.mock.calls[0][2]).toBe(2);
  });

  it("a bare number still sets the quantity for the next scan", async () => {
    const { add, hook } = setup();
    act(() => hook.result.current.submit("4"));
    act(() => hook.result.current.submit("COLA"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][2]).toBe(4);
  });

  it("the prefix is used once: the next plain scan is one", async () => {
    const { add, hook } = setup();
    act(() => hook.result.current.submit("3*COLA"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.submit("COLA"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add.mock.calls.map((c) => c[2])).toEqual([3, 1]);
  });

  it("a prefixed item dropped by a lock leaves no carry: the next plain scan is one", async () => {
    resolve.mockReset();
    resolve.mockImplementation(async () => ({ product: COLA, source: "barcode" }));
    const add = jest.fn();
    let locked = true;
    const hook = renderHook(() => useCounterSaleScan({ locked, add, refocus: jest.fn() }));
    act(() => hook.result.current.submit("3*COLA"));
    await waitFor(() => expect(hook.result.current.waiting).toBe(0));
    expect(add).not.toHaveBeenCalled();
    locked = false;
    hook.rerender();
    act(() => hook.result.current.submit("COLA"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][2]).toBe(1);
  });

  it("a bare 4 then 2*COLA adds 2 (the prefix wins, never 8 or 4), and the 4 is not carried on", async () => {
    const { add, hook } = setup();
    act(() => hook.result.current.submit("4"));
    act(() => hook.result.current.submit("2*COLA"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.submit("COLA"));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
    expect(add.mock.calls.map((c) => c[2])).toEqual([2, 1]);
  });

  it("a code that merely contains an x is looked up whole", async () => {
    const { add, hook } = setup();
    act(() => hook.result.current.submit("BOX12"));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith("BOX12"));
    expect(add).not.toHaveBeenCalled();
  });
});
