import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import BuyerPortalPage from "./page";

const searchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => searchParams,
}));

jest.mock("@/lib/buyer-auth", () => ({
  ...jest.requireActual("@/lib/buyer-auth"),
  getBuyerAccessToken: () => "buyer-access-token",
  requestSellerConnection: jest.fn(),
  getBuyerProfile: jest.fn().mockResolvedValue({ emailVerified: true }),
  buyerResendVerification: jest.fn(),
}));

import { requestSellerConnection } from "@/lib/buyer-auth";

describe("BuyerPortalPage — Connect to a Seller", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls requestSellerConnection on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BuyerPortalPage />);

    // Empty-state CTA opens the modal (BuyerAuthProvider starts with no
    // stored session -> sellers stays []).
    // First test in the file pays the cold module-compile cost; a 5 s default times out on slow CI/Windows hosts.
    await user.click(
      await screen.findByRole("button", { name: /connect to a seller/i }, { timeout: 15_000 }),
    );
    await user.click(screen.getByRole("button", { name: /send request/i }));

    expect(await screen.findByText("Seller company code is required")).toBeInTheDocument();
    expect(requestSellerConnection).not.toHaveBeenCalled();
  });

  it("sends a connection request with the minimum valid fields", async () => {
    (requestSellerConnection as jest.Mock).mockResolvedValue({ message: "Connected!" });
    const user = userEvent.setup();
    renderWithProviders(<BuyerPortalPage />);

    await user.click(await screen.findByRole("button", { name: /connect to a seller/i }));
    await user.type(screen.getByPlaceholderText("e.g. acme-foods"), "acme-foods");
    await user.type(
      screen.getByPlaceholderText("The email your seller knows you by"),
      "buyer@example.com",
    );
    await user.click(screen.getByRole("button", { name: /send request/i }));

    await waitFor(() => {
      expect(requestSellerConnection).toHaveBeenCalledWith(
        "acme-foods",
        "buyer@example.com",
        "buyer-access-token",
      );
    });
    // "Connected!" renders twice — the success heading AND the server's
    // literal `resultMessage` body text (RF's own copy: the heading text is
    // derived FROM resultMessage when it starts with "Connected").
    expect(await screen.findAllByText("Connected!")).toHaveLength(2);
  });
});
