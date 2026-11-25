/**
 * C1 (SA-1304, copy ruling 7172194631): the plan chooser offers a yearly cycle only when GET plans says
 * `annualCheckout === true`, and a yearly refusal from the server drops the pick back to Monthly and
 * refetches the plans.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import ChoosePlanPage from "./page";

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const mockInvalidate = jest.fn();
jest.mock("@tanstack/react-query", () => ({
  ...jest.requireActual("@tanstack/react-query"),
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));

const quoteBody = (cycle: string) => ({
  planKey: "GROWTH",
  planName: "Growth",
  cycle,
  isCustom: false,
  lines: [],
  subtotalMonthly: 100,
  dueToday: cycle === "ANNUAL" ? 1000 : 100,
  annualSaving: 0,
  renewalAt: "2027-11-25T00:00:00Z",
  change: null,
});

const growth = {
  planKey: "GROWTH",
  name: "Growth",
  monthlyPrice: 100,
  annualPrice: 1000,
  isCustom: false,
  customersIncluded: 250,
  sortOrder: 1,
};

let mockCatalog: Record<string, unknown>;
let mockQuoteRefusal: string | null;
let mockCommitRefusal: string | null;
const mockDispatch = jest.fn();

jest.mock("@/lib/api/billing", () => ({
  usePlans: () => ({ isLoading: false, data: mockCatalog }),
  useRecommendation: () => ({ data: undefined }),
  useSubscription: () => ({ data: undefined }),
  useQuote: () => ({
    mutate: (
      body: { cycle: string },
      o?: { onSuccess?: (q: unknown) => void; onError?: (e: unknown) => void },
    ) => {
      if (mockQuoteRefusal && body.cycle === "ANNUAL") {
        o?.onError?.({ response: { data: { code: mockQuoteRefusal } } });
      } else {
        o?.onSuccess?.(quoteBody(body.cycle));
      }
    },
    isPending: false,
  }),
  useSubscribe: () => ({ mutate: jest.fn(), isPending: false }),
  useUpgrade: () => ({ mutate: jest.fn(), isPending: false }),
  useDowngrade: () => ({ mutate: jest.fn(), isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  dispatchPlanChange: (...a: unknown[]) => mockDispatch(...a),
}));

const OFFER_WORD = /annual|yearly|a year|per year|months? free|\/ ?yr/i;

beforeEach(() => {
  jest.clearAllMocks();
  mockCatalog = { plans: [growth], annualCheckout: true };
  mockQuoteRefusal = null;
  mockCommitRefusal = null;
  mockDispatch.mockImplementation(
    (_p: unknown, _o: unknown, h: { onError: (e: unknown) => void }) => {
      if (mockCommitRefusal) h.onError({ response: { data: { code: mockCommitRefusal } } });
    },
  );
});

describe("C1 plan chooser yearly offer is closed unless the server opens it", () => {
  it("C-T5: a closed chooser shows no offer word and no yearly toggle", () => {
    mockCatalog = { plans: [growth], annualCheckout: false };
    const { container } = render(<ChoosePlanPage />);
    expect(screen.queryByRole("button", { name: "Monthly" })).toBeNull();
    expect(screen.getByText("$100")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(OFFER_WORD);
  });

  it("today's API (no annualCheckout field at all) shows no yearly toggle", () => {
    mockCatalog = { plans: [growth] };
    render(<ChoosePlanPage />);
    expect(screen.queryByRole("button", { name: /Annual/ })).toBeNull();
    expect(screen.getByText("$100")).toBeInTheDocument();
  });

  it("an open chooser (annualCheckout true) shows the yearly toggle and its price", () => {
    render(<ChoosePlanPage />);
    fireEvent.click(screen.getByRole("button", { name: "Annual" }));
    expect(screen.getByText("$1,000")).toBeInTheDocument();
    expect(screen.getByText("/yr")).toBeInTheDocument();
  });
});

describe("C1 a yearly refusal falls back to Monthly", () => {
  it.each([
    API_ERROR_CODES.CHECKOUT_ANNUAL_NOT_SUPPORTED,
    API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED,
  ])("C-T6: %s on the quote resets to Monthly and refetches plans", (code) => {
    mockQuoteRefusal = code;
    render(<ChoosePlanPage />);
    fireEvent.click(screen.getByRole("button", { name: "Annual" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(screen.queryByText("$1,000")).toBeNull();
    expect(screen.getByText("/mo")).toBeInTheDocument();
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["billing", "plans"] });
  });

  it.each([
    API_ERROR_CODES.CHECKOUT_ANNUAL_NOT_SUPPORTED,
    API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED,
  ])("C-T6: %s on the commit resets to Monthly and refetches plans", (code) => {
    mockCommitRefusal = code;
    render(<ChoosePlanPage />);
    fireEvent.click(screen.getByRole("button", { name: "Annual" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    fireEvent.click(screen.getByRole("button", { name: "Subscribe to Growth" }));
    expect(screen.getByText("/mo")).toBeInTheDocument();
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["billing", "plans"] });
  });
});
