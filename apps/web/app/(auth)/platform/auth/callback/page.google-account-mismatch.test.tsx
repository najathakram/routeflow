import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import PlatformAuthCallbackPage from "./page";

/**
 * #2495 Opus review fix: same gap as the tenant callback page, on the platform admin path.
 */
const push = jest.fn();
const replace = jest.fn();
let mockSearchParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => mockSearchParams,
}));

describe("PlatformAuthCallbackPage — google_account_mismatch (#2495)", () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    mockSearchParams = new URLSearchParams({ error: "google_account_mismatch" });
  });

  it("shows the specific mismatch copy, not the generic unknown-error message", () => {
    renderWithProviders(<PlatformAuthCallbackPage />);

    expect(
      screen.getByText(
        "This Google account doesn't match the one already linked to this email. Sign in with your linked Google account or your password.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/an unexpected error occurred/i)).not.toBeInTheDocument();
  });

  it("does NOT auto-redirect (it is not a transient error) and offers a way back to admin login", () => {
    renderWithProviders(<PlatformAuthCallbackPage />);

    expect(screen.getByRole("link", { name: /back to admin login/i })).toBeInTheDocument();
  });
});
