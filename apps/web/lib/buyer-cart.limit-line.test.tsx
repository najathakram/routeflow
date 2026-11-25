import * as React from "react";
import { act, renderHook, screen } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { useBuyerCart, type CartItem } from "./buyer-cart";

/**
 * B1382 (SA-1292 section 0): a merge through Add that hits the cap clamps AND says so. Without a provider the Add
 * still clamps and stays silent (the hook never throws for the want of a toast).
 */
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);
const plain = (qty: number): CartItem => ({
  productId: "p1",
  name: "Widget",
  unit: "each",
  unitsPerBox: null,
  qty,
});
const caseLine = (cases: number): CartItem => ({
  productId: "p2",
  name: "Case widget",
  unit: "each",
  unitsPerBox: 12,
  qty: cases * 12,
  boxes: cases,
  pieces: 0,
});

beforeEach(() => localStorage.clear());

describe("useBuyerCart.addItem at the limit (B1382)", () => {
  it("a line at the cap plus Add stays at the cap and shows the limit line", async () => {
    const { result } = renderHook(() => useBuyerCart("b1", "acme"), { wrapper });
    act(() => result.current.addItem(plain(100_000)));
    act(() => result.current.addItem(plain(1)));
    expect(result.current.items[0].qty).toBe(100_000);
    expect(await screen.findByText("The most you can order at once is 100,000.")).toBeTruthy();
  });

  it("a Case line at 8,333 Cases plus a Case says the case limit", async () => {
    const { result } = renderHook(() => useBuyerCart("b1", "acme"), { wrapper });
    act(() => result.current.addItem(caseLine(8333)));
    act(() => result.current.addItem(caseLine(1)));
    expect(result.current.items[0].boxes).toBe(8333);
    expect(await screen.findByText("The most you can order at once is 8,333 cases.")).toBeTruthy();
  });

  it("an Add below the cap shows no line", () => {
    const { result } = renderHook(() => useBuyerCart("b1", "acme"), { wrapper });
    act(() => result.current.addItem(plain(5)));
    act(() => result.current.addItem(plain(1)));
    expect(result.current.items[0].qty).toBe(6);
    expect(screen.queryByText(/The most you can order/)).toBeNull();
  });

  it("without a ToastProvider the Add clamps and does not throw", () => {
    const { result } = renderHook(() => useBuyerCart("b1", "acme"));
    act(() => result.current.addItem(plain(100_000)));
    act(() => result.current.addItem(plain(1)));
    expect(result.current.items[0].qty).toBe(100_000);
  });
});
