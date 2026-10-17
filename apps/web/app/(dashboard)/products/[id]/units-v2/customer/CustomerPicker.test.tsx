import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { CustomerPicker } from "./CustomerPicker";
import { CUSTOMER_VIEW_TESTIDS as T } from "./customer-testids";

// K11-04 (the list stays shut until asked, the active row is visible) and K11-05 (the list filters
// as you type). The picker is tested alone: only the customers hook is mocked.
const mockCustomers = jest.fn();
jest.mock("@/lib/api/customers", () => ({
  useCustomers: (...a: unknown[]) => mockCustomers(...a),
}));

const HITS = [
  { id: "c1", businessName: "Corner Cafe", contactName: "Sam" },
  { id: "c2", businessName: "Acme Deli", contactName: "Pat" },
];

const setHits = (hits: typeof HITS) => mockCustomers.mockReturnValue({ data: { data: hits } });
const input = () => screen.getByTestId(T.search);

beforeEach(() => {
  mockCustomers.mockReset();
  setHits(HITS);
});

describe("K11-04: the customer list stays shut until asked", () => {
  it("renders no listbox on mount and says it is collapsed", () => {
    render(<CustomerPicker onPick={jest.fn()} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  it("focus opens the list; blur and Escape close it", () => {
    render(<CustomerPicker onPick={jest.fn()} />);
    act(() => input().focus());
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input()).toHaveAttribute("aria-expanded", "true");
    act(() => input().blur());
    expect(screen.queryByRole("listbox")).toBeNull();
    act(() => input().focus());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });

  it("typing opens the list", () => {
    render(<CustomerPicker onPick={jest.fn()} />);
    fireEvent.change(input(), { target: { value: "c" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("the active option wears a brand tint and a left bar, never only the hover grey", () => {
    render(<CustomerPicker onPick={jest.fn()} />);
    act(() => input().focus());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const first = screen.getByTestId(T.result("c1"));
    expect(input().getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.className).toContain("bg-brand-500/10");
    expect(first.className).toContain("border-l-brand-600");
    expect(first.className).toContain("font-medium");
    expect(first.className).not.toContain("bg-surface-muted");
    // The rows that are not active keep a transparent bar so nothing shifts when the highlight moves.
    const other = screen.getByTestId(T.result("c2"));
    expect(other.className).toContain("border-l-transparent");
    expect(other.className).not.toContain("bg-brand-500/10");
  });

  it("hover moves the same highlight, so mouse and keyboard look alike", () => {
    render(<CustomerPicker onPick={jest.fn()} />);
    act(() => input().focus());
    const second = screen.getByTestId(T.result("c2"));
    fireEvent.mouseEnter(second);
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second.className).toContain("bg-brand-500/10");
    expect(second.className).toContain("border-l-brand-600");
    expect(second.className).not.toContain("bg-surface-muted");
  });
});
