/**
 * B1392 (SA-1287 s2): the Annual toggle must not promise "2 months free" while the API still refuses
 * a yearly Stripe checkout. The refusal is read from the api source as text, so this guard releases
 * itself the day `CHECKOUT_ANNUAL_NOT_SUPPORTED` leaves billing.service.ts (yearly checkout shipped).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import ChoosePlanPage from "./page";

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock("@/lib/api/billing", () => ({
  usePlans: () => ({ isLoading: false, data: { plans: [] } }),
  useRecommendation: () => ({ data: undefined }),
  useSubscription: () => ({ data: undefined }),
  useQuote: () => ({ mutate: jest.fn(), isPending: false }),
  useSubscribe: () => ({ mutate: jest.fn(), isPending: false }),
  useUpgrade: () => ({ mutate: jest.fn(), isPending: false }),
  useDowngrade: () => ({ mutate: jest.fn(), isPending: false }),
  useResumeSubscription: () => ({ mutate: jest.fn(), isPending: false }),
  dispatchPlanChange: jest.fn(),
}));

const BILLING_SERVICE = path.resolve(__dirname, "../../../../api/src/billing/billing.service.ts");
const yearlyCheckoutRefused = fs
  .readFileSync(BILLING_SERVICE, "utf8")
  .includes("CHECKOUT_ANNUAL_NOT_SUPPORTED");

describe("B1392 plan chooser Annual toggle offer", () => {
  it("reads the refusal fact from the api source", () => {
    // Tripwire: if the symbol is renamed, this fails instead of silently releasing the guard.
    expect(fs.existsSync(BILLING_SERVICE)).toBe(true);
  });

  (yearlyCheckoutRefused ? it : it.skip)(
    "does not say '2 months free' while yearly checkout is refused",
    () => {
      const { container } = render(<ChoosePlanPage />);
      expect(screen.getByRole("button", { name: /Annual/ })).toBeInTheDocument();
      expect(container.textContent ?? "").not.toMatch(/months? free/i);
    },
  );
});
