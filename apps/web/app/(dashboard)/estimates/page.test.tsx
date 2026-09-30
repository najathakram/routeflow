import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import EstimatesPage from "./page";

// REG-B79 (rc-b79): the create-estimate form lets an operator pick an
// issue date, but the submit dto historically dropped it on the floor — every
// estimate was created with the server's default (today), silently discarding
// whatever the operator typed. This is the red-gate test demonstrating that
// bug (submit payload drops issueDate); it must fail on its assertion until
// the fix lands. The read-fallback pin test (PIN-B79) lives separately in
// page.regression.test.tsx.

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/estimates",
  useSearchParams: () => new URLSearchParams(),
}));

const mockUseEstimates = jest.fn((..._args: unknown[]) => ({
  data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
  isLoading: false,
  isError: false,
}));

const createEstimateMutate = jest.fn();

jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimates: (...args: unknown[]) => mockUseEstimates(...args),
  useCreateEstimate: () => ({ mutate: createEstimateMutate, isPending: false }),
}));

const CUSTOMER = {
  id: "cust-1",
  businessName: "Acme Foods",
  contactName: "Jane",
  pricingTier: 1,
};

const PRODUCT = {
  id: "prod-1",
  name: "Widget",
  sku: "WID-1",
  unit: "each",
  pricePerUnit: 10,
  isActive: true,
};

jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [CUSTOMER] }, isLoading: false, isError: false }),
  useCustomerPrices: () => ({ data: [], isLoading: false, isError: false }),
}));

jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [PRODUCT] }, isLoading: false, isError: false }),
}));

jest.mock("@/lib/api/tier-labels", () => ({
  ...jest.requireActual("@/lib/api/tier-labels"),
  useTierLabels: () => ({ data: {}, isLoading: false, isError: false }),
}));

describe("EstimatesPage — REG-B79 issueDate write path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseEstimates.mockReturnValue({
      data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    });
  });

  it("REG-B79 web submit carries issueDate", async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimatesPage />);

    await user.click(screen.getByRole("button", { name: "New Estimate" }));

    const dialog = await screen.findByRole("dialog");

    // Select customer
    await user.type(within(dialog).getByPlaceholderText(/search customers/i), "Acme");
    await user.click(await within(dialog).findByText("Acme Foods"));

    // Add a line item so the "add at least one product" validation passes
    await user.type(within(dialog).getByPlaceholderText(/search by name, sku/i), "Widget");
    await user.click(await within(dialog).findByText("Widget"));

    // Set issue date — the label has no htmlFor/id association, so select the
    // first of the two `type="date"` inputs (Issue Date, then Expiry Date).
    // fireEvent.change (not user.clear/user.type) sets the value directly:
    // userEvent's keystroke-by-keystroke typing into a native `type="date"`
    // input is locale/OS-dependent across jsdom environments and is flaky
    // under a different runner (CI failed here with the mutate mock never
    // called — the typed keystrokes never resolved to a valid date).
    const dateInputs = dialog.querySelectorAll('input[type="date"]');
    const issueDateInput = dateInputs[0] as HTMLInputElement;
    fireEvent.change(issueDateInput, { target: { value: "2026-09-01" } });

    await user.click(within(dialog).getByRole("button", { name: /create estimate/i }));

    await waitFor(() => expect(createEstimateMutate).toHaveBeenCalled());

    expect(createEstimateMutate.mock.calls[0][0]).toEqual(
      expect.objectContaining({ issueDate: "2026-09-01" }),
    );
  });
});
