import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimatesPage from "./page";

// PIN-B79 (rc-b79): readers were patched to fall back to `createdAt` when
// `issueDate` is null, which must keep working for legacy rows. This is a
// pin/regression test for already-fixed behavior — it is expected to pass,
// and is kept separate from the REG-B79 red-gate test in page.test.tsx (which
// demonstrates the still-open write-path bug: the submit dto drops issueDate).

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/estimates",
  useSearchParams: () => new URLSearchParams(),
}));

const mockUseEstimates = jest.fn((..._args: unknown[]) => ({
  data: { data: [] as Estimate[], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
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

function makeEstimate(overrides: Partial<Estimate> = {}): Estimate {
  return {
    id: "est-1",
    estimateNumber: "EST-0001",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods", contactName: "Jane" },
    status: "DRAFT" as EstimateStatus,
    issueDate: "2026-01-01",
    expiresAt: "2026-02-01",
    subtotal: 100,
    taxAmount: 8,
    total: 108,
    notes: undefined,
    items: [],
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  };
}

describe("EstimatesPage — PIN-B79 issueDate read fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseEstimates.mockReturnValue({
      data: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 1 } },
      isLoading: false,
      isError: false,
    });
  });

  it("PIN-B79 readers fall back to createdAt when issueDate is null", async () => {
    mockUseEstimates.mockReturnValue({
      data: {
        data: [
          makeEstimate({
            id: "est-legacy",
            estimateNumber: "EST-LEGACY",
            issueDate: null,
            createdAt: "2026-08-15T12:00:00.000Z",
          }),
          makeEstimate({
            id: "est-new",
            estimateNumber: "EST-NEW",
            issueDate: "2026-09-01T12:00:00.000Z",
          }),
        ],
        meta: { total: 2, page: 1, limit: 20, totalPages: 1 },
      },
      isLoading: false,
      isError: false,
    });

    renderWithProviders(<EstimatesPage />);

    const legacyRow = (await screen.findByText("EST-LEGACY")).closest("tr")!;
    expect(within(legacyRow).getByText("Aug 15, 2026")).toBeInTheDocument();

    const newRow = screen.getByText("EST-NEW").closest("tr")!;
    expect(within(newRow).getByText("Sep 1, 2026")).toBeInTheDocument();
  });
});
