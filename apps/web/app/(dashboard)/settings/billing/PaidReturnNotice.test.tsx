import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test-utils/render";
import { PaidReturnNotice } from "./PaidReturnNotice";

let mockQuery = "";
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockQuery),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

describe("PaidReturnNotice", () => {
  it("?paid=1 says the payment can take a few minutes to confirm", () => {
    mockQuery = "paid=1";
    renderWithProviders(<PaidReturnNotice />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Payment received. It can take a few minutes to confirm.",
    );
  });

  it("can be dismissed", async () => {
    mockQuery = "paid=1";
    renderWithProviders(<PaidReturnNotice />);
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(
      screen.queryByText("Payment received. It can take a few minutes to confirm."),
    ).toBeNull();
  });

  it("no param, or any other value: nothing", () => {
    for (const q of ["", "paid=0", "checkout=cancelled"]) {
      mockQuery = q;
      const { container, unmount } = renderWithProviders(<PaidReturnNotice />);
      expect(container.textContent).toBe("");
      unmount();
    }
  });
});
