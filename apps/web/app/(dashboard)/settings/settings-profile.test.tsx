import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

/**
 * Only the "profile" tab's node is placed in SettingsPageInner's returned
 * tree for `?tab=profile` (see the SECTIONS map + `section.node` in
 * app/(dashboard)/settings/page.tsx) — the other tabs' hooks never mount, so
 * this test only needs to satisfy BusinessProfileTab's own dependencies.
 */
const searchParams = new URLSearchParams("tab=profile");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn().mockResolvedValue({ data: {} }),
    delete: jest.fn(),
  },
}));

import { apiClient as apiClientMock } from "@/lib/api-client";

describe("SettingsPage — Business Profile tab", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the zod validation message and never PATCHes /settings on an invalid submit", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    // Wait for the /settings GET to resolve and the form to hydrate empty.
    await screen.findByLabelText("Business Name");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findAllByText("Required")).not.toHaveLength(0);
    expect(apiClientMock.patch).not.toHaveBeenCalled();
  });

  it("saves the minimum valid fields", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    await user.type(await screen.findByLabelText("Business Name"), "Acme Foods");
    await user.type(screen.getByLabelText("Account Email"), "ops@acme.test");
    await user.type(screen.getByLabelText("Owner / Manager Name"), "Jane Doe");
    await user.type(screen.getByLabelText("Phone"), "5125550100");
    await user.type(screen.getByLabelText("Street"), "123 Main St");
    await user.type(screen.getByLabelText("City"), "Austin");
    await user.type(screen.getByLabelText("ZIP Code"), "78701");

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({
          businessName: "Acme Foods",
          email: "ops@acme.test",
          ownerName: "Jane Doe",
          street: "123 Main St",
          city: "Austin",
          zip: "78701",
        }),
      );
    });
  });
});
