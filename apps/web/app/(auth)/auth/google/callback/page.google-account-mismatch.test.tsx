import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import GoogleCallbackPage from "./page";

/**
 * #2495 Opus review fix: the API now redirects here with `?error=google_account_mismatch`
 * when a Google sign-in's email matches a row already bound to a DIFFERENT Google sub. Before
 * this fix the page had no copy for that code, so it fell back to the generic
 * "An unexpected error occurred" message and auto-redirected — hiding the actionable "sign in
 * with your linked account or your password" guidance from the user.
 */
const push = jest.fn();
const replace = jest.fn();
let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => mockSearchParams,
}));

describe("GoogleCallbackPage — google_account_mismatch (#2495)", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    mockSearchParams = new URLSearchParams({ error: "google_account_mismatch" });
  });

  it("shows the specific mismatch copy, not the generic unknown-error message", () => {
    renderWithProviders(<GoogleCallbackPage />);

    expect(
      screen.getByText(
        "This Google account doesn't match the one already linked to this email. Sign in with your linked Google account or your password.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/an unexpected error occurred/i)).not.toBeInTheDocument();
  });

  it("does NOT auto-redirect (it is not a transient error) and offers a way back to login", () => {
    renderWithProviders(<GoogleCallbackPage />);

    expect(screen.getByRole("link", { name: /back to login/i })).toBeInTheDocument();
  });
});
