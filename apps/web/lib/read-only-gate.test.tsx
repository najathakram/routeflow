import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { act } from "@testing-library/react";
import { renderWithProviders, screen } from "@/test-utils/render";
import {
  ReadOnlyGateProvider,
  ReadOnlyHint,
  WriteButton,
  WriteLink,
  markReadOnlyRefused,
  resetReadOnlyRefusedForTests,
} from "./read-only-gate";

/**
 * SA-733r6 (B4) owner ruling 10-10: while read-only, new order / invoice / estimate / counter sale / record payment
 * are VISIBLE but DISABLED with the exact line; nothing is hidden. Outside the shell the gate is open.
 */
const view = (over: Partial<SubscriptionView> = {}) =>
  ({ status: "READ_ONLY", billingContactName: "Dana", ...over }) as SubscriptionView;

function Screen() {
  return (
    <div>
      <WriteButton href="/orders?action=new">New Order</WriteButton>
      <WriteButton onClick={() => undefined}>Record Payment</WriteButton>
      <ReadOnlyHint />
    </div>
  );
}

describe("read-only gate", () => {
  it("read-only: the controls stay in the DOM, disabled, and the exact line sits next to them", () => {
    renderWithProviders(
      <ReadOnlyGateProvider view={view()}>
        <Screen />
      </ReadOnlyGateProvider>,
    );
    const order = screen.getByRole("button", { name: "New Order" });
    const pay = screen.getByRole("button", { name: "Record Payment" });
    expect(order).toBeDisabled();
    expect(pay).toBeDisabled();
    const line = screen.getByTestId("read-only-line");
    expect(line).toHaveTextContent("Not available while read-only. Dana can restore it.");
    expect(order).toHaveAttribute("aria-describedby", line.id);
    expect(screen.queryByRole("link", { name: "New Order" })).toBeNull(); // cannot navigate
  });

  it("no admin on file: 'Your admin can restore it.'", () => {
    renderWithProviders(
      <ReadOnlyGateProvider view={view({ billingContactName: null })}>
        <Screen />
      </ReadOnlyGateProvider>,
    );
    expect(screen.getByTestId("read-only-line")).toHaveTextContent(
      "Not available while read-only. Your admin can restore it.",
    );
  });

  it("an ACTIVE workspace: enabled, no line", () => {
    renderWithProviders(
      <ReadOnlyGateProvider view={view({ status: "ACTIVE" })}>
        <Screen />
      </ReadOnlyGateProvider>,
    );
    expect(screen.getByRole("button", { name: "Record Payment" })).toBeEnabled();
    expect(screen.queryByTestId("read-only-line")).toBeNull();
  });

  it("without a provider (public pages, tests) writes are never gated", () => {
    renderWithProviders(<Screen />);
    expect(screen.getByRole("button", { name: "Record Payment" })).toBeEnabled();
    expect(screen.queryByTestId("read-only-line")).toBeNull();
  });
});

// S5: a 403 READ_ONLY on a control the page still thought was enabled must put the line NEXT TO that control (not
// only in a toast): the refusal flips the gate at once, before the subscription re-read lands.
describe("read-only gate - a 403 READ_ONLY refusal", () => {
  afterEach(() => {
    resetReadOnlyRefusedForTests();
    jest.useRealTimers();
  });

  it("disables the write controls and shows the exact line even though the cached view says ACTIVE", () => {
    renderWithProviders(
      <ReadOnlyGateProvider view={view({ status: "ACTIVE" })}>
        <Screen />
      </ReadOnlyGateProvider>,
    );
    expect(screen.getByRole("button", { name: "Record Payment" })).toBeEnabled();
    act(() => markReadOnlyRefused());
    expect(screen.getByRole("button", { name: "Record Payment" })).toBeDisabled();
    expect(screen.getByTestId("read-only-line")).toHaveTextContent(
      "Not available while read-only. Dana can restore it.",
    );
  });

  it("lets the fresh read decide again after a minute (a stale refusal never sticks)", () => {
    jest.useFakeTimers();
    renderWithProviders(
      <ReadOnlyGateProvider view={view({ status: "ACTIVE" })}>
        <Screen />
      </ReadOnlyGateProvider>,
    );
    act(() => markReadOnlyRefused());
    expect(screen.getByRole("button", { name: "Record Payment" })).toBeDisabled();
    act(() => {
      jest.advanceTimersByTime(61_000);
    });
    expect(screen.getByRole("button", { name: "Record Payment" })).toBeEnabled();
  });
});

describe("WriteLink", () => {
  it("read-only: a disabled button (cannot navigate) pointing at the line; open: a real link", () => {
    const ro = renderWithProviders(
      <ReadOnlyGateProvider view={view()}>
        <WriteLink href="/invoices/new">New Invoice</WriteLink>
        <ReadOnlyHint />
      </ReadOnlyGateProvider>,
    );
    expect(screen.queryByRole("link", { name: "New Invoice" })).toBeNull();
    const btn = screen.getByRole("button", { name: "New Invoice" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-describedby", screen.getByTestId("read-only-line").id);
    ro.unmount();
    renderWithProviders(<WriteLink href="/invoices/new">New Invoice</WriteLink>);
    expect(screen.getByRole("link", { name: "New Invoice" })).toHaveAttribute(
      "href",
      "/invoices/new",
    );
  });
});
