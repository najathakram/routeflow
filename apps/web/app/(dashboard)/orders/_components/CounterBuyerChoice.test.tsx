import * as React from "react";
import { renderWithProviders, screen, fireEvent } from "@/test-utils/render";
import { CounterBuyerChoice } from "./CounterBuyerChoice";

describe("CounterBuyerChoice (S5)", () => {
  it("asks, with Walk-in one tap, and draws no New customer button until S6 supplies one", () => {
    const onWalkIn = jest.fn();
    renderWithProviders(<CounterBuyerChoice kind={null} disabled={false} onWalkIn={onWalkIn} />);
    expect(screen.getByRole("group", { name: "Who's buying?" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New customer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Walk-in" }));
    expect(onWalkIn).toHaveBeenCalledTimes(1);
  });

  it("offers New customer once the entry point is passed", () => {
    const onNew = jest.fn();
    renderWithProviders(
      <CounterBuyerChoice
        kind={null}
        disabled={false}
        onWalkIn={jest.fn()}
        onNewCustomer={onNew}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New customer" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("answered: names the customer, with a way back to Walk-in; Walk-in names itself", () => {
    const { rerender } = renderWithProviders(
      <CounterBuyerChoice
        kind="customer"
        customerName="Acme Cafe"
        disabled={false}
        onWalkIn={jest.fn()}
      />,
    );
    expect(screen.getByText("Acme Cafe")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Walk-in customer" })).toBeInTheDocument();
    rerender(<CounterBuyerChoice kind="walk-in" disabled={false} onWalkIn={jest.fn()} />);
    expect(screen.getByText("Walk-in customer")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is off while the cart is frozen", () => {
    renderWithProviders(<CounterBuyerChoice kind={null} disabled onWalkIn={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Walk-in" })).toBeDisabled();
  });
});
