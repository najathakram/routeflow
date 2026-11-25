/**
 * B1392 (SA-1287 s2, R-170): the plan chooser must not claim a yearly discount ("2 months free" on
 * the Annual toggle, "You save $X a year" on the quote panel) while the API refuses a yearly Stripe
 * checkout. The guard is tied to the shared error-code constant and to the api throw site, with no
 * silent skip: if either goes away the first test FAILS, so whoever changes yearly checkout must
 * decide whether the offer may come back.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { API_ERROR_CODES } from "@routeflow/types";
import ChoosePlanPage from "./page";

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const annualQuote = {
  planKey: "GROWTH",
  planName: "Growth",
  cycle: "ANNUAL",
  isCustom: false,
  lines: [],
  subtotalMonthly: 100,
  dueToday: 1000,
  annualSaving: 200,
  renewalAt: "2027-11-25T00:00:00Z",
  change: null,
};

jest.mock("@/lib/api/billing", () => ({
  usePlans: () => ({
    isLoading: false,
    data: {
      plans: [
        {
          planKey: "GROWTH",
          name: "Growth",
          monthlyPrice: 100,
          annualPrice: 1000,
          isCustom: false,
          customersIncluded: 250,
          sortOrder: 1,
        },
      ],
    },
  }),
  useRecommendation: () => ({ data: undefined }),
  useSubscription: () => ({ data: undefined }),
  // The quote answers at once with a yearly quote that carries a saving.
  useQuote: () => ({
    mutate: (_body: unknown, o?: { onSuccess?: (q: unknown) => void }) =>
      o?.onSuccess?.(annualQuote),
    isPending: false,
  }),
  useSubscribe: () => ({ mutate: jest.fn(), isPending: false }),
  useUpgrade: () => ({ mutate: jest.fn(), isPending: false }),
  useDowngrade: () => ({ mutate: jest.fn(), isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  dispatchPlanChange: jest.fn(),
}));

const BILLING_SERVICE = path.resolve(__dirname, "../../../../api/src/billing/billing.service.ts");
const SYMBOL = "CHECKOUT_ANNUAL_NOT_SUPPORTED";

describe("B1392 plan chooser yearly offer", () => {
  it("is still guarded: the shared code exists and the api still refuses a year", () => {
    const declared = (API_ERROR_CODES as Record<string, string | undefined>)[SYMBOL];
    const thrown = fs.readFileSync(BILLING_SERVICE, "utf8").includes(`API_ERROR_CODES.${SYMBOL}`);
    if (declared !== SYMBOL || !thrown) {
      throw new Error(
        `yearly checkout changed: decide whether the offer may come back (${SYMBOL}: declared=${declared}, thrown in billing.service.ts=${thrown})`,
      );
    }
  });

  it("does not say '2 months free' on the Annual toggle", () => {
    const { container } = render(<ChoosePlanPage />);
    expect(screen.getByRole("button", { name: /Annual/ })).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/months? free/i);
  });

  it("does not claim a yearly saving on the quote panel of an Annual pick", () => {
    const { container } = render(<ChoosePlanPage />);
    fireEvent.click(screen.getByRole("button", { name: /Annual/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/you save|months? free/i);
  });
});
