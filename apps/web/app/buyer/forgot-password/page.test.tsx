import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import BuyerForgotPasswordPage from "./page";

jest.mock("@/lib/buyer-auth", () => ({
  ...jest.requireActual("@/lib/buyer-auth"),
  buyerRequestPasswordReset: jest.fn().mockResolvedValue(undefined),
}));

import { buyerRequestPasswordReset } from "@/lib/buyer-auth";

describe("BuyerForgotPasswordPage", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls the API on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BuyerForgotPasswordPage />);

    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText("Email is required")).toBeInTheDocument();
    expect(buyerRequestPasswordReset).not.toHaveBeenCalled();
  });

  it("submits the trimmed, lowercased email", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BuyerForgotPasswordPage />);

    await user.type(screen.getByLabelText("Email"), "Jane@Example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(buyerRequestPasswordReset).toHaveBeenCalledWith("jane@example.com");
    });
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
  });
});
