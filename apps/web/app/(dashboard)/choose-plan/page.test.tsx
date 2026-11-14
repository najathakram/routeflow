/**
 * UX guide B10: the plan the business is on is marked from the server's own `currentPlanKey` before any
 * quote is asked for, its button cannot be pressed when pressing it would change nothing, and the cheapest
 * covering plan reads "Fits your usage" (a hint about usage, not advice to move).
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
  monthly: number,
  annual: number,
) => ({
  planKey,
  name,
  monthlyPrice: monthly,
  annualPrice: annual,
  isCustom: false,
  seatsIncluded: 5,
  routesConcurrent: 2,
  scansIncluded: 100,
  msgsIncluded: 0,
  featureFlags: [],
  sortOrder,
});

let mockRec: { currentPlanKey: string; recommendedPlanKey: string };
let mockSub: Record<string, unknown> | undefined;
const mockQuote = jest.fn();
jest.mock("@/lib/api/billing", () => ({
  usePlans: () => ({
    isLoading: false,
    data: {
      plans: [plan("GROWTH", "Growth", 1, 100, 1000), plan("SCALE", "Scale", 2, 300, 3000)],
    },
  }),
  useRecommendation: () => ({ data: mockRec }),
  useSubscription: () => ({ data: mockSub }),
  useQuote: () => ({ mutate: (...a: unknown[]) => mockQuote(...a), isPending: false }),
  useSubscribe: () => ({ mutate: jest.fn(), isPending: false }),
  useUpgrade: () => ({ mutate: jest.fn(), isPending: false }),
  useDowngrade: () => ({ mutate: jest.fn(), isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  dispatchPlanChange: jest.fn(),
}));

const card = (name: string) => screen.getByRole("heading", { name }).closest("div")!.parentElement!;

beforeEach(() => {
  jest.clearAllMocks();
  mockRec = { currentPlanKey: "SCALE", recommendedPlanKey: "GROWTH" };
  mockSub = {
    planKey: "SCALE",
    cycle: "MONTHLY",
    cancelAtPeriodEnd: false,
    downgradeToPlanKey: null,
  };
});

describe("UX guide B10 choose-plan current plan", () => {
  it("marks the current plan with a badge and a disabled button before any quote", () => {
    render(<ChoosePlanPage />);
    const scale = card("Scale");
    expect(within(scale).getByText("Current plan", { selector: "span,div" })).toBeInTheDocument();
    expect(within(scale).getByRole("button", { name: "Current plan" })).toBeDisabled();
    expect(within(scale).queryByRole("button", { name: "Choose" })).toBeNull();
    expect(within(card("Growth")).getByRole("button", { name: "Choose" })).toBeEnabled();
  });

  it("calls the cheapest covering plan 'Fits your usage', not 'Best fit', and explains it", () => {
    render(<ChoosePlanPage />);
    expect(within(card("Growth")).getByText("Fits your usage")).toBeInTheDocument();
    expect(screen.queryByText("Best fit")).toBeNull();
    expect(
      screen.getByText(/cheapest plan that covers your current users, routes and AI scans/i),
    ).toBeInTheDocument();
  });

  it("keeps the own-plan button live when it still does something: a scheduled change to cancel", () => {
    mockSub = { ...mockSub, downgradeToPlanKey: "GROWTH" };
    render(<ChoosePlanPage />);
    const button = within(card("Scale")).getByRole("button", { name: "Choose" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(mockQuote).toHaveBeenCalledWith(
      { planKey: "SCALE", cycle: "MONTHLY" },
      expect.anything(),
    );
  });

  it("keeps the own-plan button live on the other billing cycle (a cycle switch)", () => {
    render(<ChoosePlanPage />);
    fireEvent.click(screen.getByRole("button", { name: /Annual/ }));
    expect(within(card("Scale")).getByRole("button", { name: "Choose" })).toBeEnabled();
    expect(
      within(card("Scale")).getByText("Current plan", { selector: "span,div" }),
    ).toBeInTheDocument();
  });
});
