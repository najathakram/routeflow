import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import GoogleCallbackPage from "./page";

/**
 * The API redirects here with `?error=seller_unavailable` when the invite on a Google sign-in belongs to a seller
 * whose workspace is not taking it. The page shows one fixed neutral line (never a reason) and a way back to login,
 * and does not auto-redirect.
 */
const push = jest.fn();
const replace = jest.fn();
let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => mockSearchParams,
}));

describe("GoogleCallbackPage - seller_unavailable", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    mockSearchParams = new URLSearchParams({ error: "seller_unavailable" });
  });

  it("shows the fixed seller copy, not the generic unknown-error message", () => {
    renderWithProviders(<GoogleCallbackPage />);
    expect(
      screen.getByText(
        "This seller isn't taking online orders right now. Please check back soon or contact them.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/an unexpected error occurred/i)).not.toBeInTheDocument();
  });

  it("offers a way back to login and does not auto-redirect", () => {
    renderWithProviders(<GoogleCallbackPage />);
    expect(screen.getByRole("link", { name: /back to login/i })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
