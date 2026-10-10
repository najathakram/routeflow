import * as React from "react";
import userEvent from "@testing-library/user-event";
import type { SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { BillingShellBanner } from "./BillingShellBanner";

const mockPortalMutate = jest.fn();
jest.mock("@/lib/api/billing", () => ({
  useBillingPortal: () => ({ mutate: mockPortalMutate, isPending: false }),
}));
jest.mock("@/lib/counter-cart-signal", () => ({ guardCounterLeave: () => false }));

/**
 * SA-733r6 (B4) shell strip: the slot, the roles, the dismiss rules and the Don't list. The copy itself is
 * pinned state x role in lib/subscription-banner-state.test.ts; this proves the DOM renders what the function says.
 */
const DAY = 86_400_000;
const view = (daysAgo: number, over: Partial<SubscriptionView> = {}): SubscriptionView => ({
  planKey: "TEAM",
  planName: "Team",
  status: "ACTIVE",
  cycle: "MONTHLY",
  monthlyPrice: 149,
  annualPrice: null,
  isCustom: false,
  renewalAt: null,
  cancelAtPeriodEnd: false,
  downgradeToPlanKey: null,
  downgradeEffectiveAt: null,
  trialEndsAt: null,
  addons: [],
  paymentRequired: false,
  billingContactName: "Dana",
  pastDueSince: new Date(Date.now() - daysAgo * DAY - 3_600_000).toISOString(),
  pastDueInvoiceId: "in_1",
  openInvoiceAmount: 149,
  ...over,
});
const paused = () => view(8, { status: "READ_ONLY", readOnlyReason: "payment_overdue" });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe("BillingShellBanner - the shell strip", () => {
  it("grace (day 2), admin: neutral blue, role=status, Update payment, dismissible", async () => {
    renderWithProviders(<BillingShellBanner view={view(2)} userRole="TENANT_ADMIN" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveAttribute("role", "status");
    expect(strip.className).toMatch(/blue/);
    expect(strip.className).not.toMatch(/red/);
    expect(strip.className).toMatch(/\bh-8\b/); // 32 px at 390
    expect(strip.className).toMatch(/md:h-9/); // 36 px at >= 768
    expect(within(strip).getByText(/We couldn't charge your card for/)).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("button", { name: "Update payment" }));
    expect(mockPortalMutate).toHaveBeenCalledWith({ intent: "update-payment" });
    expect(within(strip).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("dismissing a grace strip hides it for the day", async () => {
    renderWithProviders(<BillingShellBanner view={view(1)} userRole="TENANT_ADMIN" />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("a grace strip stays dismissed on the next mount the same day", async () => {
    const first = renderWithProviders(
      <BillingShellBanner view={view(1)} userRole="TENANT_ADMIN" />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    first.unmount();
    renderWithProviders(<BillingShellBanner view={view(1)} userRole="TENANT_ADMIN" />);
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("day 6: amber, role=alert, NOT dismissible", async () => {
    renderWithProviders(<BillingShellBanner view={view(6)} userRole="TENANT_ADMIN" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveAttribute("role", "alert");
    expect(strip.className).toMatch(/amber/);
    expect(within(strip).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("read-only, admin: role=alert once, amber, Pay $149.00, not dismissible", async () => {
    renderWithProviders(<BillingShellBanner view={paused()} userRole="TENANT_ADMIN" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveAttribute("role", "alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await userEvent.click(within(strip).getByRole("button", { name: "Pay $149.00" }));
    expect(mockPortalMutate).toHaveBeenCalledWith({ intent: "pay" });
    expect(within(strip).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("operator: the same strip names the admin and has NO action button in the DOM", async () => {
    renderWithProviders(<BillingShellBanner view={paused()} userRole="OPERATOR" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveTextContent(
      "Your workspace is read-only. You can still view, print and export. Dana can restore it.",
    );
    expect(within(strip).queryByRole("button", { name: /pay|update/i })).toBeNull();
  });

  it("a tap on the text opens a sheet with the full sentence", async () => {
    renderWithProviders(<BillingShellBanner view={view(2)} userRole="OPERATOR" />);
    const strip = await screen.findByTestId("subscription-strip");
    await userEvent.click(within(strip).getByTitle(/billing issue/i));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "There's a billing issue. Everything still works. Dana can sort it out in Billing.",
    );
  });

  it("buyers get no billing state at all, whatever the view says", () => {
    const { container } = renderWithProviders(
      <BillingShellBanner view={paused()} userRole="CUSTOMER" />,
    );
    expect(container.textContent ?? "").not.toMatch(/payment|billing|subscribe/i);
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("never says overdue / failed / suspended or offers a plan purchase", async () => {
    for (const [v, role] of [
      [view(2), "TENANT_ADMIN"],
      [view(6), "OPERATOR"],
      [paused(), "TENANT_ADMIN"],
    ] as const) {
      const { container, unmount } = renderWithProviders(
        <BillingShellBanner view={v} userRole={role} />,
      );
      await screen.findByTestId("subscription-strip");
      expect(container.textContent ?? "").not.toMatch(
        /overdue|failed|suspend|choose a plan|subscribe/i,
      );
      unmount();
    }
  });

  it("a healthy workspace renders nothing (no reserved gap)", () => {
    renderWithProviders(
      <BillingShellBanner
        view={view(0, { pastDueSince: null, pastDueInvoiceId: null, openInvoiceAmount: null })}
        userRole="TENANT_ADMIN"
      />,
    );
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a trial-ended read-only workspace keeps the existing banner (its own copy and plan link)", async () => {
    renderWithProviders(
      <BillingShellBanner
        view={view(0, {
          status: "READ_ONLY",
          readOnlyReason: "trial_expired",
          pastDueSince: null,
          pastDueInvoiceId: null,
        })}
        userRole="TENANT_ADMIN"
      />,
    );
    expect(await screen.findByText(/Your trial ended/)).toBeInTheDocument();
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("an owed invoice hides the old banner's 'Choose a plan' even for a non-payment reason", () => {
    renderWithProviders(
      <BillingShellBanner
        view={view(9, { status: "READ_ONLY", readOnlyReason: "subscription_cancelled" })}
        userRole="TENANT_ADMIN"
      />,
    );
    expect(screen.queryByRole("link", { name: /choose a plan/i })).toBeNull();
  });
});
