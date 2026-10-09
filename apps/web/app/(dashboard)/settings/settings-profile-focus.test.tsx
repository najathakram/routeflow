import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import SettingsPage from "./page";

const searchParams = new URLSearchParams("tab=profile");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

import { apiClient } from "@/lib/api-client";

const get = apiClient.get as jest.Mock;
const patch = apiClient.patch as jest.Mock;

const SAVED = {
  businessName: "Acme Foods",
  email: "ops@acme.test",
  ownerName: "Jane Doe",
  phone: "5125550100",
  customerEmail: "",
  street: "123 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  taxRate: 8.25,
};

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: SAVED });
  patch.mockResolvedValue({ data: {} });
});

describe("Business profile — invalid submit (web-2 #6)", () => {
  it("focuses the owner-name field, toasts 'Fix 1 field', and leaves Save enabled", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const owner = await screen.findByLabelText("Owner / Manager Name");
    await waitFor(() => expect(owner).toHaveValue("Jane Doe"));
    await user.clear(owner);
    const save = screen.getByRole("button", { name: /save changes/i });
    await user.click(save);

    expect(await screen.findByText("Fix 1 field")).toBeInTheDocument();
    await waitFor(() => expect(owner).toHaveFocus());
    expect(save).not.toBeDisabled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps Save enabled while the form is invalid", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const zip = await screen.findByLabelText("ZIP Code");
    await waitFor(() => expect(zip).toHaveValue("78701"));
    await user.clear(zip);
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await screen.findByText("Fix 1 field");
    expect(screen.getByRole("button", { name: /save changes/i })).not.toBeDisabled();
  });
});

describe("Business profile — tax rate", () => {
  it("re-hydrates 8.25 from GET and PATCHes 8.25", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const tax = await screen.findByLabelText("Default Tax Rate");
    await waitFor(() => expect(tax).toHaveValue(8.25));
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings", expect.objectContaining({ taxRate: 8.25 })),
    );
  });

  it("explains where the rate applies", async () => {
    renderWithProviders(<SettingsPage />);
    expect(await screen.findByText("Charged on counter sales and invoices")).toBeInTheDocument();
  });
});

describe("Business profile — receipt footer", () => {
  const FIXED = "That receipt text couldn't be saved. Keep it under 200 characters.";

  it("is a 200-character plain-text field with a live counter, hydrated from GET", async () => {
    get.mockResolvedValue({ data: { ...SAVED, receiptFooter: "Thanks!" } });
    renderWithProviders(<SettingsPage />);
    const footer = await screen.findByLabelText("Receipt footer");
    await waitFor(() => expect(footer).toHaveValue("Thanks!"));
    expect(footer).toHaveAttribute("maxlength", "200");
    expect(screen.getByText("7/200")).toBeInTheDocument();
  });

  it("PATCHes receiptFooter when changed and omits it when untouched", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const footer = await screen.findByLabelText("Receipt footer");
    await waitFor(() => expect(screen.getByLabelText("Default Tax Rate")).toHaveValue(8.25));
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).not.toHaveProperty("receiptFooter");

    await user.type(footer, "Thank you!");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1][1]).toEqual(
      expect.objectContaining({ receiptFooter: "Thank you!" }),
    );
  });

  it("shows FIXED copy on a 400, never the server's text", async () => {
    const user = userEvent.setup();
    patch.mockRejectedValue({
      response: { status: 400, data: { message: "<img src=x onerror=alert(1)> raw server text" } },
    });
    renderWithProviders(<SettingsPage />);
    const footer = await screen.findByLabelText("Receipt footer");
    await waitFor(() => expect(screen.getByLabelText("Default Tax Rate")).toHaveValue(8.25));
    await user.type(footer, "Thank you!");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText(FIXED)).toBeInTheDocument();
    expect(screen.queryByText(/raw server text/)).toBeNull();
  });
});
