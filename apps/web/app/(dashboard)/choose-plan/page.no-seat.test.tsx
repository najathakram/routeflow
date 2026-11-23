/**
 * B1371 (SA-1175 K4, K6): no plan has a seat limit. The cards show what is enforced (customers), the
 * sub-head says so, and a downgrade confirm never asks for a "users will be deactivated" tick, even when
 * an older API still sends `seatAckRequired: true`.
 */
import * as React from "react";
import { render, screen, within, fireEvent } from "@testing-library/react";
import ChoosePlanPage from "./page";

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const plan = (
  planKey: string,
  name: string,
  sortOrder: number,
  customersIncluded: number | null,
) => ({
  planKey,
  name,
  monthlyPrice: 100 * sortOrder,
  annualPrice: 1000 * sortOrder,
  isCustom: false,
  seatsIncluded: 5,
  routesConcurrent: 2,
  scansIncluded: 100,
  msgsIncluded: 0,
  customersIncluded,
  featureFlags: [],
  sortOrder,
});

const mockQuote = jest.fn();
const mockDowngrade = jest.fn();
jest.mock("@/lib/api/billing", () => ({
  usePlans: () => ({
    isLoading: false,
    data: {
      plans: [plan("GROWTH", "Growth", 1, 250), plan("ENTERPRISE", "Enterprise", 2, null)],
    },
  }),
  useRecommendation: () => ({
    data: { currentPlanKey: "ENTERPRISE", recommendedPlanKey: "GROWTH" },
  }),
  useSubscription: () => ({
    data: {
      planKey: "ENTERPRISE",
      status: "ACTIVE",
      renewalAt: "2026-12-01T00:00:00Z",
      cycle: "MONTHLY",
      cancelAtPeriodEnd: false,
      downgradeToPlanKey: null,
    },
  }),
  useQuote: () => ({ mutate: (...a: unknown[]) => mockQuote(...a), isPending: false }),
  useSubscribe: () => ({ mutate: jest.fn(), isPending: false }),
  useUpgrade: () => ({ mutate: jest.fn(), isPending: false }),
  useDowngrade: () => ({ mutate: (...a: unknown[]) => mockDowngrade(...a), isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  dispatchPlanChange: jest.fn((preview: unknown, h: { downgrade: (...a: unknown[]) => void }) =>
    h.downgrade(preview),
  ),
}));

const card = (name: string) => screen.getByRole("heading", { name }).closest("div")!.parentElement!;

beforeEach(() => jest.clearAllMocks());

describe("B1371 plan cards show customers, not seats, routes or scans", () => {
  it("shows the customer allowance and nothing else", () => {
    render(<ChoosePlanPage />);
    const growth = card("Growth");
    expect(within(growth).getByText("250 customers included")).toBeInTheDocument();
    expect(within(growth).queryByText(/user/i)).toBeNull();
    expect(within(growth).queryByText(/route/i)).toBeNull();
    expect(within(growth).queryByText(/AI scans/i)).toBeNull();
  });

  it("says Unlimited customers for a null allowance", () => {
    render(<ChoosePlanPage />);
    expect(within(card("Enterprise")).getByText("Unlimited customers")).toBeInTheDocument();
  });

  it("the sub-head reads exactly as ruled", () => {
    render(<ChoosePlanPage />);
    expect(screen.getByText("Start small. Add customers as you grow.")).toBeInTheDocument();
  });
});

describe("B1371 downgrade confirm has no seat checkbox", () => {
  it("schedules the downgrade with no checkbox even when the old API says seatAckRequired", () => {
    mockQuote.mockImplementation((_vars: unknown, h: { onSuccess: (q: unknown) => void }) =>
      h.onSuccess({
        planKey: "GROWTH",
        planName: "Growth",
        cycle: "MONTHLY",
        isCustom: false,
        lines: [],
        subtotalMonthly: 100,
        dueToday: 0,
        annualSaving: 0,
        renewalAt: "2026-12-01T00:00:00Z",
        change: {
          action: "DOWNGRADE",
          fromPlanKey: "ENTERPRISE",
          effectiveAt: "2026-12-01T00:00:00Z",
          proratedNow: 0,
          warning: null,
          seatAckRequired: true,
        },
      }),
    );
    render(<ChoosePlanPage />);
    fireEvent.click(within(card("Growth")).getByRole("button", { name: "Choose" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/deactivated/i)).toBeNull();
    const go = screen.getByRole("button", { name: "Schedule downgrade" });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(mockDowngrade).toHaveBeenCalled();
  });
});
