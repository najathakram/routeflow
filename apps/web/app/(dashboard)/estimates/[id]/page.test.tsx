import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import type { Estimate, EstimateStatus } from "@/lib/api/estimates";
import EstimateDetailPage from "./page";

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
    items: [{ id: "item-1", description: "Widget", qty: 1, unitPrice: 100, subtotal: 100 } as any],
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  };
}

const mockUseEstimate = jest.fn((..._args: unknown[]) => ({
  data: makeEstimate(),
  isLoading: false,
  isError: false,
}));

const sendEstimateMutate = jest.fn();
const convertEstimateMutate = jest.fn();
const routerPushMock = jest.fn();
const toastMock = jest.fn();

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "est-1" }),
  useRouter: () => ({ push: routerPushMock }),
}));

jest.mock("@/lib/api/estimates", () => ({
  ...jest.requireActual("@/lib/api/estimates"),
  useEstimate: (...args: unknown[]) => mockUseEstimate(...args),
  useSendEstimate: () => ({ mutate: sendEstimateMutate, isPending: false }),
  useAcceptEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useDeclineEstimate: () => ({ mutate: jest.fn(), isPending: false }),
  useConvertEstimateToInvoice: () => ({ mutate: convertEstimateMutate, isPending: false }),
  useVoidEstimate: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: toastMock, dismiss: jest.fn() }),
}));

/** Renders the page with a DRAFT (or overridden-status) estimate. */
function renderEstimatePage({ status }: { status?: EstimateStatus } = {}) {
  mockUseEstimate.mockReturnValue({
    data: makeEstimate(status ? { status } : {}),
    isLoading: false,
    isError: false,
  });
  return renderWithProviders(<EstimateDetailPage />);
}

// rt-b17-web: the convert-to-invoice failure toast hardcoded "Please try
// again." instead of surfacing the server's rejection reason, so a caller
// who tried to convert a non-ACCEPTED estimate (or hit any other guard) had
// no way to tell why it failed. These are the RED-gate tests for the bug —
// see page.existing-behavior.test.tsx for the pre-existing, already-correct
// UI behavior this task does not change.
describe("EstimateDetailPage — REG-B15 convert failure toast surfaces server reason (rt-b15)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("REG-B15 convert failure toast surfaces the server reason", async () => {
    const user = userEvent.setup();
    convertEstimateMutate.mockImplementation(
      (_id: string, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({ response: { data: { message: "Estimate must be ACCEPTED" } } });
      },
    );

    renderEstimatePage({ status: "ACCEPTED" as EstimateStatus });

    const convertButton = screen.getAllByRole("button", { name: /convert to invoice/i })[0];
    await user.click(convertButton);

    await waitFor(() => expect(toastMock).toHaveBeenCalled());

    const lastCall = toastMock.mock.calls[toastMock.mock.calls.length - 1][0];
    expect(lastCall.description).toContain("Estimate must be ACCEPTED");
    expect(lastCall.description).not.toBe("Please try again.");
  });

  it("REG-B15 convert failure toast surfaces the server reason (array message)", async () => {
    const user = userEvent.setup();
    convertEstimateMutate.mockImplementation(
      (_id: string, opts?: { onError?: (err: unknown) => void }) => {
        opts?.onError?.({
          response: { data: { message: ["Estimate must be ACCEPTED", "x"] } },
        });
      },
    );

    renderEstimatePage({ status: "ACCEPTED" as EstimateStatus });

    const convertButton = screen.getAllByRole("button", { name: /convert to invoice/i })[0];
    await user.click(convertButton);

    await waitFor(() => expect(toastMock).toHaveBeenCalled());

    const lastCall = toastMock.mock.calls[toastMock.mock.calls.length - 1][0];
    expect(lastCall.description).toContain("Estimate must be ACCEPTED");
    expect(lastCall.description).not.toBe("Please try again.");
  });
});

// rt-b15: REG-B15 — the convert-to-invoice control renders whenever a
// canConvert predicate is satisfied, but earlier logic let it show on
// non-ACCEPTED estimates too. Only an ACCEPTED estimate may render it.
describe("EstimateDetailPage — REG-B15 convert control gated to ACCEPTED (rt-b15)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("REG-B15 convert control is absent on DRAFT", () => {
    renderEstimatePage({ status: "DRAFT" as EstimateStatus });

    expect(screen.queryAllByRole("button", { name: /convert to invoice/i })).toHaveLength(0);
  });

  it("REG-B15 convert control is absent on SENT", () => {
    renderEstimatePage({ status: "SENT" as EstimateStatus });

    expect(screen.queryAllByRole("button", { name: /convert to invoice/i })).toHaveLength(0);
  });
});

// rt-b15: REG-B15-NAV — the server's created-Invoice response is keyed `id`,
// not `invoiceId`. Navigating on the wrong key sends the caller to
// /invoices/undefined instead of the real invoice.
describe("EstimateDetailPage — REG-B15-NAV convert navigates to returned invoice (rt-b15)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("REG-B15-NAV successful convert navigates to the returned invoice", async () => {
    const user = userEvent.setup();
    convertEstimateMutate.mockImplementation(
      (_id: string, opts?: { onSuccess?: (inv: unknown) => void }) => {
        opts?.onSuccess?.({ id: "inv_1" });
      },
    );

    renderEstimatePage({ status: "ACCEPTED" as EstimateStatus });

    const convertButton = screen.getAllByRole("button", { name: /convert to invoice/i })[0];
    await user.click(convertButton);

    await waitFor(() => expect(routerPushMock).toHaveBeenCalled());

    expect(routerPushMock).toHaveBeenCalledWith("/invoices/inv_1");
  });
});

// rt-b15: PIN-B15 — pin the two ACCEPTED-only render sites (header action bar
// + sidebar summary card) so a future edit can't silently drop one.
describe("EstimateDetailPage — PIN-B15 ACCEPTED convert control count (rt-b15)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("PIN-B15 ACCEPTED renders exactly 2 convert controls", () => {
    renderEstimatePage({ status: "ACCEPTED" as EstimateStatus });

    expect(screen.getAllByRole("button", { name: /convert to invoice/i })).toHaveLength(2);
  });
});
