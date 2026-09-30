import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import ForgotPasswordPage from "./page";

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

import { apiClient } from "@/lib/api-client";

describe("ForgotPasswordPage (operator)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never calls the API on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForgotPasswordPage />);

    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText("Email is required")).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("submits the trimmed, lowercased email with surface: web", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForgotPasswordPage />);

    await user.type(screen.getByLabelText("Email"), "  Jane@Example.com  ");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith("/auth/request-password-reset", {
        email: "jane@example.com",
        surface: "web",
      });
    });
    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
  });
});
