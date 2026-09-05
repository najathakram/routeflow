import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
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

function clearPresenceCookies() {
  for (const name of ["rf-op-auth", "rf-buyer-auth", "rf-last-portal"]) {
    document.cookie = `${name}=; path=/; max-age=0`;
  }
}

describe("BuyerLoginPage — portal switcher (T18, T19)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    clearPresenceCookies();
  });

  // T18 (R10, R12): an active operator session shows a status notice with a
  // link to the seller dashboard.
  it("T18: shows a seller-dashboard presence notice when rf-op-auth is set", () => {
    document.cookie = "rf-op-auth=1; path=/";

    renderWithProviders(<BuyerLoginPage />);

    const status = screen.queryByRole("status");
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("You're signed in to a seller dashboard.");

    const link = screen.queryByRole("link", { name: /go to seller dashboard/i });
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/dashboard");
  });

  // T19 (R10): no operator session -> no notice, and the footer points at
  // /login with the new copy (never the old "Staff Portal" text).
  it("T19: shows no presence notice and the updated footer link when signed out", () => {
    renderWithProviders(<BuyerLoginPage />);

    expect(screen.queryByRole("status")).toBeNull();

    const link = screen.queryByRole("link", { name: /sign in to the seller dashboard/i });
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/login");

    expect(screen.queryByText(/staff portal/i)).toBeNull();
  });
});
