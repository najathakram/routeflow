import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { BuyerOversellCard, OVERSELL_COPY } from "./BuyerOversellCard";

/**
 * Settings → Out-of-stock ordering. The card is a switch over `orders.buyerOversell`:
 * only the exact value "backorder" is ON; loading / error / an unknown value never render a switch
 * that could be mistaken for ON (fail-closed); a TENANT_ADMIN edits, anyone else reads; every toast
 * is fixed copy (never the server's text).
 */
const query = jest.fn();
const mutate = jest.fn();
const refetch = jest.fn();
const toast = jest.fn();
let pending = false;

jest.mock("@/lib/api/inventory-settings", () => ({
  useInventorySettings: () => query(),
  useUpdateInventorySettings: () => ({ mutate, isPending: pending }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const loaded = (buyerOversell: string, customerOverrides = 0) =>
  query.mockReturnValue({
    data: { buyerOversell, customerOverrides },
    isLoading: false,
    isError: false,
    refetch,
  });

const theSwitch = () => screen.getByRole("switch", { name: OVERSELL_COPY.label });

beforeEach(() => {
  jest.clearAllMocks();
  pending = false;
});

describe("BuyerOversellCard", () => {
  it('reads "off" as unchecked and exactly "backorder" as checked', () => {
    loaded("off");
    const { unmount } = renderWithProviders(<BuyerOversellCard canEdit />);
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    unmount();

    loaded("backorder");
    renderWithProviders(<BuyerOversellCard canEdit />);
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it.each(["", "BACKORDER", "on", "true", "allow"])(
    "an unknown stored value (%j) is OFF, never on",
    (value) => {
      loaded(value);
      renderWithProviders(<BuyerOversellCard canEdit />);
      expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    },
  );

  it('turning it ON sends exactly {buyerOversell:"backorder"}', () => {
    loaded("off");
    renderWithProviders(<BuyerOversellCard canEdit />);
    fireEvent.click(theSwitch());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toStrictEqual({ buyerOversell: "backorder" });
  });

  it('turning it OFF sends exactly {buyerOversell:"off"}', () => {
    loaded("backorder");
    renderWithProviders(<BuyerOversellCard canEdit />);
    fireEvent.click(theSwitch());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toStrictEqual({ buyerOversell: "off" });
  });

  it("success toasts are fixed copy for each direction", () => {
    loaded("off");
    renderWithProviders(<BuyerOversellCard canEdit />);
    fireEvent.click(theSwitch());
    mutate.mock.calls[0][1].onSuccess();
    expect(toast).toHaveBeenLastCalledWith({ variant: "success", title: OVERSELL_COPY.savedOn });
  });

  it("a failed save toasts FIXED copy (never the server's text) and the switch keeps the server value", () => {
    loaded("off");
    renderWithProviders(<BuyerOversellCard canEdit />);
    fireEvent.click(theSwitch());
    mutate.mock.calls[0][1].onError(new Error("duplicate key value violates unique constraint"));
    expect(toast).toHaveBeenLastCalledWith({ variant: "error", title: OVERSELL_COPY.saveFailed });
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/duplicate key/);
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("while loading there is NO switch (never a guessed value)", () => {
    query.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch });
    renderWithProviders(<BuyerOversellCard canEdit />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("when the load failed there is NO switch, a fixed message and a working Retry", () => {
    query.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    renderWithProviders(<BuyerOversellCard canEdit />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText(OVERSELL_COPY.loadFailed)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a non-admin sees the switch DISABLED with the read-only note, and a click sends nothing", () => {
    loaded("backorder");
    renderWithProviders(<BuyerOversellCard canEdit={false} />);
    expect(theSwitch()).toBeDisabled();
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(OVERSELL_COPY.readOnly)).toBeInTheDocument();
    fireEvent.click(theSwitch());
    expect(mutate).not.toHaveBeenCalled();
  });

  it("an admin has no read-only note and an enabled switch; a pending save disables it", () => {
    loaded("off");
    const { rerender } = renderWithProviders(<BuyerOversellCard canEdit />);
    expect(theSwitch()).toBeEnabled();
    expect(screen.queryByText(OVERSELL_COPY.readOnly)).not.toBeInTheDocument();
    pending = true;
    rerender(<BuyerOversellCard canEdit />);
    expect(theSwitch()).toBeDisabled();
  });

  it("says how many customers have their own setting (and nothing when none do)", () => {
    loaded("off", 0);
    const { unmount } = renderWithProviders(<BuyerOversellCard canEdit />);
    expect(screen.queryByText(/their own setting/)).not.toBeInTheDocument();
    unmount();

    loaded("off", 1);
    const second = renderWithProviders(<BuyerOversellCard canEdit />);
    expect(screen.getByText(/1 customer has their own setting/)).toBeInTheDocument();
    second.unmount();

    loaded("off", 4);
    renderWithProviders(<BuyerOversellCard canEdit />);
    expect(screen.getByText(/4 customers have their own setting/)).toBeInTheDocument();
  });

  it("the copy says what the switch does: below zero, backorder, and that staff can always oversell", () => {
    loaded("off");
    renderWithProviders(<BuyerOversellCard canEdit />);
    expect(screen.getByText(OVERSELL_COPY.label)).toBeInTheDocument();
    expect(OVERSELL_COPY.description).toMatch(/below zero/);
    expect(OVERSELL_COPY.description).toMatch(/backorder/);
    expect(OVERSELL_COPY.description).toMatch(/Staff can always/);
    expect(screen.getByText(OVERSELL_COPY.description)).toBeInTheDocument();
  });
});
