import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import LoginPage from "./page";

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

// jsdom's default hostname is "localhost" -> tenantSlugFromHostname returns
// null (see lib/tenant-host.test.ts), so the Workspace field is shown.
import { apiClient } from "@/lib/api-client";

function clearPresenceCookies() {
  for (const name of ["rf-op-auth", "rf-buyer-auth", "rf-last-portal"]) {
    document.cookie = `${name}=; path=/; max-age=0`;
  }
}

describe("LoginPage — portal switcher (T10, T16, T17)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    clearPresenceCookies();
    window.history.replaceState(null, "", "/login");
  });

  // T10 (R4): a safe `redirect` search param is honoured after sign-in.
  it("T10: pushes the sanitized redirect target from the search params after sign-in", async () => {
    window.history.replaceState(
      null,
      "",
      "/login?redirect=" + encodeURIComponent("/orders/abc?tab=1"),
    );
    (apiClient.post as jest.Mock).mockResolvedValueOnce({
      data: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: {
          id: "u1",
          username: "operator1",
          role: "OPERATOR",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantSlug: "acme",
        },
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText("Workspace"), "acme");
    await user.type(screen.getByLabelText("Username or email"), "operator1");
    await user.type(screen.getByLabelText("Password"), "s3cret-pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/orders/abc?tab=1"));
  });

  // T16 (R9, R12): an active buyer session shows a status notice with a link
  // to the buyer portal.
  it("T16: shows a buyer-portal presence notice when rf-buyer-auth is set", () => {
    document.cookie = "rf-buyer-auth=1; path=/";

    renderWithProviders(<LoginPage />);

    const status = screen.queryByRole("status");
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("You're signed in to the buyer portal.");

    const link = screen.queryByRole("link", { name: /go to buyer portal/i });
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/buyer/portal");
  });

  // T17 (R9): no buyer session -> no notice, and the footer points at
  // /buyer/login with the new copy (never the old "retailer portal" text).
  it("T17: shows no presence notice and the updated footer link when signed out", () => {
    renderWithProviders(<LoginPage />);

    expect(screen.queryByRole("status")).toBeNull();

    const link = screen.queryByRole("link", { name: /sign in to the buyer portal/i });
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/buyer/login");

    expect(screen.queryByText(/retailer portal/i)).toBeNull();
  });
});
