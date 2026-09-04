import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import BuyerLoginPage from "./page";

const push = jest.fn();
const searchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

jest.mock("@/lib/buyer-auth", () => ({
  ...jest.requireActual("@/lib/buyer-auth"),
  buyerLogin: jest.fn(),
}));

import { buyerLogin } from "@/lib/buyer-auth";

describe("BuyerLoginPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("shows the zod validation message and never calls the API on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BuyerLoginPage />);

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByText("Password is required")).toBeInTheDocument();
    expect(buyerLogin).not.toHaveBeenCalled();
  });

  it("logs in with the minimum valid fields and calls the API with the typed credentials", async () => {
    (buyerLogin as jest.Mock).mockResolvedValueOnce({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      buyer: { id: "b1", email: "buyer@example.com" },
    });

    const user = userEvent.setup();
    renderWithProviders(<BuyerLoginPage />);

    await user.type(screen.getByLabelText("Email"), "buyer@example.com");
    await user.type(screen.getByLabelText("Password"), "s3cret-pw");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => {
      expect(buyerLogin).toHaveBeenCalledWith("buyer@example.com", "s3cret-pw");
    });
  });
});
