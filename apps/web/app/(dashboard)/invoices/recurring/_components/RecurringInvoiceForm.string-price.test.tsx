import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import type { RecurringInvoice } from "@/lib/api/invoices";
import { RecurringInvoiceForm } from "./RecurringInvoiceForm";

/**
 * Hotfix (W-693 split, SA-856 type nit): the API serves a product's `pricePerUnit` as a decimal STRING (a Prisma Decimal).
 * Picking it put the string into the line's numeric unit price and the price field threw `value.toFixed is not a function`,
 * taking the whole New / Edit Recurring Template page down. The pick must store a number. No pricing change: the line
 * still pre-fills the catalog price (the customer's own price is W-693).
 */
const P = {
  id: "p-tea",
  name: "Iced Tea 16oz",
  unit: "each",
  pricePerUnit: "4.50",
  isActive: true,
};
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [P] } }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [] } }),
  // W-693 (SA-856): the form reads the customer's pricing; a tier-1 customer with no overrides pays the list price.
  useCustomer: (id: string) => ({
    data: id ? { id, businessName: "Acme Cafe", pricingTier: 1 } : undefined,
    isLoading: false,
  }),
  useCustomerPrices: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/lib/api/useCustomerPriceLayer", () => ({
  ...jest.requireActual("@/lib/api/useCustomerPriceLayer"),
  useCustomerPriceLayer: () => ({
    enabled: false,
    ready: true,
    pending: false,
    failed: false,
    complete: true,
    lineReady: () => true,
    layerOf: () => undefined,
    refetch: jest.fn(),
  }),
}));

async function pickTea() {
  const input = screen.getAllByPlaceholderText("Description / product…").at(-1) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "tea" } });
  fireEvent.click(await screen.findByRole("button", { name: /Iced Tea 16oz/ }));
}

describe("recurring template line: a decimal-string catalog price never crashes the form", () => {
  it("New template: picking a product with a string price fills 4.50 and stays on the page", async () => {
    renderWithProviders(
      <RecurringInvoiceForm
        mode="create"
        onSubmit={jest.fn()}
        isPending={false}
        submitLabel="Save"
      />,
    );
    await pickTea();
    expect(await screen.findByDisplayValue("4.50")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Iced Tea 16oz")).toBeInTheDocument();
  });

  it("Edit template: adding a line by picking a string-priced product submits a NUMBER unit price", async () => {
    const onSubmit = jest.fn();
    const template = {
      id: "ri-1",
      customerId: "c1",
      customer: { id: "c1", businessName: "Acme Cafe" },
      frequency: "MONTHLY",
      dayOfMonth: 1,
      isActive: true,
      autoSend: false,
      nextRunAt: "2026-11-01T00:00:00.000Z",
      // The API serves stored template prices as decimal strings too.
      items: [{ description: "Delivery fee", qty: "1", unitPrice: "5.00" }],
      createdAt: "2026-10-01T00:00:00.000Z",
    } as unknown as RecurringInvoice;
    renderWithProviders(
      <RecurringInvoiceForm
        mode="edit"
        initial={template}
        onSubmit={onSubmit}
        isPending={false}
        submitLabel="Save"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add line item/ }));
    await pickTea();
    expect(await screen.findByDisplayValue("4.50")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const [fee, tea] = onSubmit.mock.calls[0][0].items;
    expect(fee.unitPrice).toBe(5);
    expect(tea.unitPrice).toBe(4.5);
    expect(typeof tea.unitPrice).toBe("number");
  });
});
