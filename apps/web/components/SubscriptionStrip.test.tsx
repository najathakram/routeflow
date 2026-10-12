import * as React from "react";
import userEvent from "@testing-library/user-event";
import type { SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { BillingShellBanner, BillingStripReserve } from "./BillingShellBanner";

const mockPortalMutate = jest.fn();
jest.mock("@/lib/api/billing", () => ({
  useBillingPortal: () => ({ mutate: mockPortalMutate, isPending: false }),
}));
const mockGuard = jest.fn((_f?: () => void) => false);
const mockPush = jest.fn();
jest.mock("@/lib/counter-cart-signal", () => ({
  guardCounterLeave: (f?: () => void) => mockGuard(f),
}));
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}));

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
  pauseEnforced: true,
  pastDueSince: new Date(Date.now() - daysAgo * DAY - 3_600_000).toISOString(),
  pastDueInvoiceId: "in_1",
  openInvoiceAmount: 149,
  ...over,
});
const paused = () => view(8, { status: "READ_ONLY", readOnlyReason: "payment_overdue" });

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("BillingShellBanner - the shell strip", () => {
  it("grace (day 2), admin: neutral blue, role=status, Update payment, dismissible", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={view(2)} userRole="TENANT_ADMIN" />);
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
    renderWithProviders(<BillingShellBanner scope="acme" view={view(1)} userRole="TENANT_ADMIN" />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("a grace strip stays dismissed on the next mount the same day", async () => {
    const first = renderWithProviders(
      <BillingShellBanner scope="acme" view={view(1)} userRole="TENANT_ADMIN" />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    first.unmount();
    renderWithProviders(<BillingShellBanner scope="acme" view={view(1)} userRole="TENANT_ADMIN" />);
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("day 6: amber, role=alert, NOT dismissible", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={view(6)} userRole="TENANT_ADMIN" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveAttribute("role", "alert");
    expect(strip.className).toMatch(/amber/);
    expect(within(strip).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("read-only, admin: role=alert once, amber, Pay $149.00, not dismissible", async () => {
    renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
    );
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveAttribute("role", "alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await userEvent.click(within(strip).getByRole("button", { name: "Pay $149.00" }));
    expect(mockPortalMutate).toHaveBeenCalledWith({ intent: "pay" });
    expect(within(strip).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("operator: the same strip names the admin and has NO action button in the DOM", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={paused()} userRole="OPERATOR" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveTextContent(
      "Your workspace is read-only. You can still view, print and export. Dana can restore it.",
    );
    expect(within(strip).queryByRole("button", { name: /pay|update/i })).toBeNull();
  });

  it("a tap on the text opens a sheet with the full sentence", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={view(2)} userRole="OPERATOR" />);
    const strip = await screen.findByTestId("subscription-strip");
    await userEvent.click(within(strip).getByTitle(/billing issue/i));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "There's a billing issue. Everything still works. Dana can sort it out in Billing.",
    );
  });

  it("buyers get no billing state at all, whatever the view says", () => {
    const { container } = renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="CUSTOMER" />,
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
        <BillingShellBanner scope="acme" view={v} userRole={role} />,
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
        scope="acme"
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
        scope="acme"
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
        scope="acme"
        view={view(9, { status: "READ_ONLY", readOnlyReason: "subscription_cancelled" })}
        userRole="TENANT_ADMIN"
      />,
    );
    expect(screen.queryByRole("link", { name: /choose a plan/i })).toBeNull();
  });
});

describe("BillingShellBanner - announce once, link, reserve (review folds)", () => {
  it("role=alert is claimed once per session per state; a later mount is a quiet status", async () => {
    const first = renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
    );
    expect(await screen.findByTestId("subscription-strip")).toHaveAttribute("role", "alert");
    first.unmount();
    renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
    );
    expect(await screen.findByTestId("subscription-strip")).toHaveAttribute("role", "status");
  });

  it("dark mode day 9: the owner's overdue sentence with Pay now, an amber dismissible status, no threat (SA-777)", async () => {
    renderWithProviders(
      <BillingShellBanner
        scope="acme"
        view={view(9, { pauseEnforced: false })}
        userRole="TENANT_ADMIN"
      />,
    );
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveAttribute("role", "status");
    expect(strip.className).toMatch(/amber/);
    expect(strip.className).not.toMatch(/red/);
    expect(strip.textContent).toContain(
      "Your subscription payment of $149.00 is overdue. Please complete your payment to keep your account up to date.",
    );
    expect(strip.textContent).not.toMatch(/read-only|tomorrow|lock|suspend|\d+ days?/i);
    expect(within(strip).getByRole("button", { name: "Pay now" })).toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("a cancelled workspace that owes an invoice: the admin gets a Billing link, never Pay", async () => {
    renderWithProviders(
      <BillingShellBanner
        scope="acme"
        view={view(9, {
          status: "READ_ONLY",
          readOnlyReason: "subscription_cancelled",
          pauseEnforced: true,
        })}
        userRole="TENANT_ADMIN"
      />,
    );
    const strip = await screen.findByTestId("subscription-strip");
    expect(within(strip).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "href",
      "/settings/billing",
    );
    expect(within(strip).queryByRole("button", { name: /pay/i })).toBeNull();
    expect(strip.textContent).not.toMatch(/goes through/i);
  });

  it("the shell remembers that a strip was showing and reserves its height while the next load is pending", async () => {
    const shown = renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
    );
    await screen.findByTestId("subscription-strip");
    shown.unmount();
    const reserve = renderWithProviders(<BillingStripReserve scope="acme" />);
    const box = reserve.container.querySelector("[data-testid=subscription-strip-reserve]");
    expect(box).not.toBeNull();
    expect(box!.className).toMatch(/\bh-8\b/);
    expect(box!.className).toMatch(/md:h-9/);
    expect(box).toHaveAttribute("aria-hidden", "true");
  });

  it("nothing is reserved for a viewer who never had a strip", () => {
    const reserve = renderWithProviders(<BillingStripReserve scope="acme" />);
    expect(reserve.container.querySelector("[data-testid=subscription-strip-reserve]")).toBeNull();
  });

  it("once a healthy read lands the memory is cleared (no stale gap next time)", async () => {
    const shown = renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
    );
    await screen.findByTestId("subscription-strip");
    shown.unmount();
    renderWithProviders(
      <BillingShellBanner
        scope="acme"
        view={view(0, { pastDueSince: null, pastDueInvoiceId: null, openInvoiceAmount: null })}
        userRole="TENANT_ADMIN"
      />,
    );
    const reserve = renderWithProviders(<BillingStripReserve scope="acme" />);
    expect(reserve.container.querySelector("[data-testid=subscription-strip-reserve]")).toBeNull();
  });
});

describe("BillingShellBanner - review folds #2", () => {
  const cancelledOwed = () =>
    view(9, { status: "READ_ONLY", readOnlyReason: "subscription_cancelled", pauseEnforced: true });

  it("role=alert survives React StrictMode (the session claim is not made during render)", async () => {
    renderWithProviders(
      <React.StrictMode>
        <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />
      </React.StrictMode>,
    );
    expect(await screen.findByTestId("subscription-strip")).toHaveAttribute("role", "alert");
  });

  it("StrictMode: a second mount in the same session is the quiet status", async () => {
    const first = renderWithProviders(
      <React.StrictMode>
        <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />
      </React.StrictMode>,
    );
    await screen.findByTestId("subscription-strip");
    first.unmount();
    renderWithProviders(
      <React.StrictMode>
        <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />
      </React.StrictMode>,
    );
    expect(await screen.findByTestId("subscription-strip")).toHaveAttribute("role", "status");
  });

  it("private mode (no sessionStorage) still announces", async () => {
    const orig = Storage.prototype.getItem;
    const spy = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key.startsWith("rf.billing.alerted")) throw new Error("denied"); // private mode
      return orig.call(this, key);
    });
    try {
      renderWithProviders(
        <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
      );
      expect(await screen.findByTestId("subscription-strip")).toHaveAttribute("role", "alert");
    } finally {
      spy.mockRestore();
    }
  });

  it("the Billing link goes through the counter leave guard (a cart is never dropped silently)", async () => {
    mockGuard.mockReturnValueOnce(true); // a cart is open: the guard parks the leave
    renderWithProviders(
      <BillingShellBanner scope="acme" view={cancelledOwed()} userRole="TENANT_ADMIN" />,
    );
    const link = await screen.findByRole("link", { name: "Billing" });
    await userEvent.click(link);
    expect(mockGuard).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("with no cart in the way the Billing link navigates with the router", async () => {
    renderWithProviders(
      <BillingShellBanner scope="acme" view={cancelledOwed()} userRole="TENANT_ADMIN" />,
    );
    await userEvent.click(await screen.findByRole("link", { name: "Billing" }));
    expect(mockPush).toHaveBeenCalledWith("/settings/billing");
  });

  it("the strip-shown hint is scoped to the tenant: another workspace reserves nothing", async () => {
    const shown = renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
    );
    await screen.findByTestId("subscription-strip");
    shown.unmount();
    const other = renderWithProviders(<BillingStripReserve scope="globex" />);
    expect(other.container.querySelector("[data-testid=subscription-strip-reserve]")).toBeNull();
    const same = renderWithProviders(<BillingStripReserve scope="acme" />);
    expect(same.container.querySelector("[data-testid=subscription-strip-reserve]")).not.toBeNull();
  });
});
