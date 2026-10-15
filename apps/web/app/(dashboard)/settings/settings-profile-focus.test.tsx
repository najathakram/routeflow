import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
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
  it("is enabled and seeded from GET /settings", async () => {
    get.mockResolvedValue({ data: { ...SAVED, receiptFooter: "Thanks!" } });
    renderWithProviders(<SettingsPage />);
    const footer = await screen.findByLabelText("Receipt footer");
    await waitFor(() => expect(footer).toHaveValue("Thanks!"));
    expect(footer).toBeEnabled();
    expect(screen.getByText("7/200")).toBeInTheDocument();
  });

  it("persists in the PATCH /settings body", async () => {
    get.mockResolvedValue({ data: { ...SAVED, receiptFooter: "Thanks!" } });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const footer = await screen.findByLabelText("Receipt footer");
    await waitFor(() => expect(footer).toHaveValue("Thanks!"));
    await user.clear(footer);
    await user.type(footer, "See you <b>soon</b>");
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        "/settings",
        expect.objectContaining({ receiptFooter: "See you <b>soon</b>" }),
      ),
    );
  });

  it("blocks a footer over 200 characters client-side", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    const footer = await screen.findByLabelText("Receipt footer");
    await waitFor(() => expect(screen.getByLabelText("Default Tax Rate")).toHaveValue(8.25));
    fireEvent.change(footer, { target: { value: "x".repeat(201) } });
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText(/200 characters or fewer/)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("maps an API 400 to fixed copy", async () => {
    patch.mockRejectedValue({ response: { status: 400, data: { message: "raw server text" } } });
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("Default Tax Rate")).toHaveValue(8.25));
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText("Couldn't save the receipt footer")).toBeInTheDocument();
    expect(screen.queryByText("raw server text")).not.toBeInTheDocument();
  });
});

describe("Business profile — saving one section (row 327)", () => {
  // A counter shop that never filled in the contact and address fields: the API stores those as empty strings,
  // so they must not block saving something else.
  const COUNTER_SHOP = {
    ...SAVED,
    ownerName: "",
    phone: "",
    street: "",
    city: "",
    state: "",
    zip: "",
  };

  it("saving ONLY the tax rate is not blocked by untouched empty contact and address fields", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: COUNTER_SHOP });
    renderWithProviders(<SettingsPage />);
    const tax = await screen.findByLabelText("Default Tax Rate");
    await waitFor(() => expect(tax).toHaveValue(8.25));
    await user.clear(tax);
    await user.type(tax, "7");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toMatchObject({ taxRate: 7 });
    expect(screen.queryByText(/Fix \d+ fields?/)).toBeNull();
  });

  it("a field the user DID touch is still checked, even when others are empty", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: COUNTER_SHOP });
    renderWithProviders(<SettingsPage />);
    const zip = await screen.findByLabelText("ZIP Code");
    await waitFor(() => expect(screen.getByLabelText("Default Tax Rate")).toHaveValue(8.25));
    await user.type(zip, "abc");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText("Fix 1 field")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid ZIP code")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("a bad tax rate is reported at the tax field itself", async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: COUNTER_SHOP });
    renderWithProviders(<SettingsPage />);
    const tax = await screen.findByLabelText("Default Tax Rate");
    await waitFor(() => expect(tax).toHaveValue(8.25));
    await user.clear(tax);
    await user.type(tax, "150");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText("Fix 1 field")).toBeInTheDocument();
    await waitFor(() => expect(tax).toHaveFocus());
    expect(patch).not.toHaveBeenCalled();
  });
});
