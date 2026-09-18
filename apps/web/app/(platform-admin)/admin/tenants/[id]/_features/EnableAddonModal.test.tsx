import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EnableAddonModal } from "./EnableAddonModal";

const mockFetchBilling = jest.fn();
const mockEnableAddon = jest.fn();

jest.mock("@/lib/platform-admin/features", () => ({
  fetchTenantBillingInfo: (tenantId: string) => mockFetchBilling(tenantId),
  enableTenantAddon: (
    tenantId: string,
    addonKey: string,
    stripePriceId?: string,
    acknowledgeUnmetRequires?: boolean,
  ) => mockEnableAddon(tenantId, addonKey, stripePriceId, acknowledgeUnmetRequires),
}));

const TENANT_ID = "tenant-1";

function renderModal(overrides: Partial<React.ComponentProps<typeof EnableAddonModal>> = {}) {
  const onClose = jest.fn();
  const onEnabled = jest.fn();
  render(
    <EnableAddonModal
      open
      onClose={onClose}
      tenantId={TENANT_ID}
      tenantLabel="Acme Wholesale"
      addonKey="ocr"
      addonLabel="OCR document scanning"
      onEnabled={onEnabled}
      {...overrides}
    />,
  );
  return { onClose, onEnabled };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("EnableAddonModal — Stripe configured", () => {
  beforeEach(() => mockFetchBilling.mockResolvedValue({ stripeConfigured: true }));

  it("disables Continue until an explicit choice is made — never a silent default", async () => {
    renderModal();
    await screen.findByText(/Choose how/);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "Bill via Stripe" }));
    // Radio picked but no price entered yet — still not a complete, explicit choice.
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Stripe price ID"), {
      target: { value: "price_123" },
    });
    expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
  });

  it("bill-via-Stripe path: confirm sends the addonKey and price, names the tenant, states a Stripe item will be created", async () => {
    const { onEnabled, onClose } = renderModal();
    await screen.findByText(/Choose how/);

    fireEvent.click(screen.getByRole("radio", { name: "Bill via Stripe" }));
    fireEvent.change(screen.getByLabelText("Stripe price ID"), {
      target: { value: "price_123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText(/Acme Wholesale/)).toBeInTheDocument();
    expect(screen.getByText(/A Stripe subscription item will be created/)).toBeInTheDocument();

    mockEnableAddon.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(mockEnableAddon).toHaveBeenCalledWith(TENANT_ID, "ocr", "price_123", undefined),
    );
    await waitFor(() => expect(onEnabled).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("grant-without-billing is its own explicit choice: confirm omits stripePriceId and states no Stripe item will be created", async () => {
    renderModal();
    await screen.findByText(/Choose how/);

    fireEvent.click(screen.getByRole("radio", { name: "Grant without billing" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText(/No Stripe subscription item will be created/),
    ).toBeInTheDocument();

    mockEnableAddon.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(mockEnableAddon).toHaveBeenCalledWith(TENANT_ID, "ocr", undefined, undefined),
    );
  });

  it("a failed enable surfaces the server message and keeps the confirm step open", async () => {
    renderModal();
    await screen.findByText(/Choose how/);
    fireEvent.click(screen.getByRole("radio", { name: "Grant without billing" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/No Stripe subscription item will be created/);

    mockEnableAddon.mockRejectedValueOnce({
      response: { data: { message: "Add-on already active" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Add-on already active")).toBeInTheDocument();
    expect(screen.getByText(/No Stripe subscription item will be created/)).toBeInTheDocument();
  });
});

describe("EnableAddonModal — Stripe NOT configured", () => {
  beforeEach(() => mockFetchBilling.mockResolvedValue({ stripeConfigured: false }));

  it("states this will be a free grant and proceeds without asking for a choice", async () => {
    renderModal();
    expect(await screen.findByText(/this will be a free grant, not billed/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText(/No Stripe subscription item will be created/),
    ).toBeInTheDocument();

    mockEnableAddon.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockEnableAddon).toHaveBeenCalledWith(TENANT_ID, "ocr", undefined, undefined),
    );
  });
});

describe("EnableAddonModal — unmet requirement (B519 warning, B524 ack prep)", () => {
  beforeEach(() => mockFetchBilling.mockResolvedValue({ stripeConfigured: false }));

  it("Confirm stays disabled until the amber warning's checkbox is ticked, then sends acknowledgeUnmetRequires: true", async () => {
    renderModal({ unmetRequirement: "Recurring routes or Order delivery" });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    const warning = await screen.findByText(/does not currently have/);
    expect(warning).toBeInTheDocument();
    const confirmButton = screen.getByRole("button", { name: "Confirm" });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(confirmButton).not.toBeDisabled();

    mockEnableAddon.mockResolvedValueOnce({});
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(mockEnableAddon).toHaveBeenCalledWith(TENANT_ID, "ocr", undefined, true),
    );
  });

  it("never sends acknowledgeUnmetRequires when there is no unmet requirement to acknowledge", async () => {
    renderModal();
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    mockEnableAddon.mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(mockEnableAddon).toHaveBeenCalledWith(TENANT_ID, "ocr", undefined, undefined),
    );
  });
});
