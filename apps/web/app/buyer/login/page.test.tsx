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

  // B891: the Enter-in-email handler focuses getElementById("buyer-password"); the field's id is
  // explicit, so the useId default can never break it.
  // W-839 / SA-937 MUST 5: "Shop" on the staff role step opens this page with the staff user's email prefilled.
  // #3731 review (4): the prefill comes from sessionStorage (read once), never from the URL.
  it("prefills the email the role step stashed, once; a URL email is ignored", () => {
    sessionStorage.setItem("rf.buyerLogin.email", "sam@acme.example");
    const { unmount } = renderWithProviders(<BuyerLoginPage />);
    expect(screen.getByLabelText("Email")).toHaveValue("sam@acme.example");
    expect(sessionStorage.getItem("rf.buyerLogin.email")).toBeNull();
    unmount();
    searchParams.set("email", "url@acme.example");
    renderWithProviders(<BuyerLoginPage />);
    expect(screen.getByLabelText("Email")).toHaveValue("");
    searchParams.delete("email");
  });

  it("the password field is findable by its explicit id, and its label targets it", () => {
    renderWithProviders(<BuyerLoginPage />);
    const byId = document.getElementById("buyer-password");
    expect(byId).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText("Password")).toBe(byId);
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
