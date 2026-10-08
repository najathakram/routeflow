import * as React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { DraftDock } from "./DraftDock";
import { setCounterCartBusy } from "@/lib/counter-cart-signal";

/** POS-7: the dock floats over the counter; Resume and "Start a new order instead" are ways out and obey the leave guard. */
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush, replace: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/drafts", () => ({
  useDrafts: () => ({
    data: [
      {
        id: "d1",
        kind: "ORDER",
        title: null,
        customerName: "Acme",
        payload: { lineItems: [] },
        updatedAt: new Date().toISOString(),
      },
    ],
  }),
  useDeleteDraft: () => ({ mutate: jest.fn(), isPending: false }),
}));

const ui = () => (
  <ToastProvider>
    <DraftDock />
  </ToastProvider>
);
const scan = (code: string) => {
  for (const key of code) fireEvent.keyDown(window, { key });
  fireEvent.keyDown(window, { key: "Enter" });
};

beforeEach(() => mockPush.mockClear());
afterEach(() => {
  cleanup();
  act(() => setCounterCartBusy(false));
});

describe("DraftDock leave guard", () => {
  it("Resume does not navigate while a sale is being recorded", () => {
    render(ui());
    act(() => setCounterCartBusy(true));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("Start a new order instead does not navigate while busy", () => {
    render(ui());
    scan("ABCDEFGH");
    act(() => setCounterCartBusy(true));
    fireEvent.click(screen.getByRole("button", { name: /Start a new order instead/ }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("not busy: Resume and Start a new order instead navigate", () => {
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    scan("ABCDEFGH");
    fireEvent.click(screen.getByRole("button", { name: /Start a new order instead/ }));
    expect(mockPush).toHaveBeenCalledTimes(2);
  });
});
