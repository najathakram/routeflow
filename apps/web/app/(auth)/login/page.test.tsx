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

describe("LoginPage (operator)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it("shows the zod validation message and never calls the API when a required field is empty", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    // Leave everything blank and submit.
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText("Workspace is required")).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("logs in with the minimum valid fields and posts the expected payload", async () => {
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

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith("/auth/login", {
        username: "operator1",
        password: "s3cret-pw",
      });
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
  });
});
