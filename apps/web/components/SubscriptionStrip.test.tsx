import * as React from "react";
import userEvent from "@testing-library/user-event";
import type { SubscriptionView } from "@routeflow/types";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { BillingShellBanner, BillingStripReserve } from "./BillingShellBanner";
import { SubscriptionStrip } from "./SubscriptionStrip";

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
  billingContactEmail: "dana@acme.test",
  pauseEnforced: true,
  pastDueSince: new Date(Date.now() - daysAgo * DAY - 3_600_000).toISOString(),
  pastDueInvoiceId: "in_1",
  openInvoiceAmount: 149,
  ...over,
});
const paused = () => view(8, { status: "READ_ONLY", readOnlyReason: "payment_overdue" });

/**
 * Row 542: in the shell, grace / overdue are drawn by the failed-renewal banner (BillingShellBanner.payment-due.test).
 * The strip component itself still draws them, so these tests render it directly.
 */
function StripOnly({ view: v, userRole }: { view: SubscriptionView; userRole: string }) {
  return <SubscriptionStrip view={v} role={userRole === "TENANT_ADMIN" ? "admin" : "staff"} />;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("BillingShellBanner - the shell strip", () => {
  it("grace (day 2), admin: neutral blue, role=status, Update payment, dismissible", async () => {
    renderWithProviders(<StripOnly view={view(2)} userRole="TENANT_ADMIN" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveAttribute("role", "status");
    expect(strip.className).toMatch(/blue/);
    expect(strip.className).not.toMatch(/red/);
    // UX QA: no fixed height - the sentence WRAPS (never truncated) and every control is a >= 44 px hit area
    expect(strip.className).not.toMatch(/(?<![\w-])h-8\b|(?<![\w-])md:h-9/);
    expect(strip.className).toMatch(/min-h-8/);
    expect(strip.innerHTML).not.toMatch(/\btruncate\b/);
    expect(within(strip).getByRole("button", { name: "Update payment" }).className).toMatch(
      /min-h-\[44px\]/,
    );
    expect(within(strip).getByRole("button", { name: "Dismiss" }).className).toMatch(
      /min-h-\[44px\].*min-w-\[44px\]|min-w-\[44px\].*min-h-\[44px\]/,
    );
    expect(within(strip).getByText(/We couldn't charge your card for/)).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("button", { name: "Update payment" }));
    expect(mockPortalMutate).toHaveBeenCalledWith({ intent: "update-payment" });
    expect(within(strip).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("dismissing a grace strip hides it for the day", async () => {
    renderWithProviders(<StripOnly view={view(1)} userRole="TENANT_ADMIN" />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("a grace strip stays dismissed on the next mount the same day", async () => {
    const first = renderWithProviders(<StripOnly view={view(1)} userRole="TENANT_ADMIN" />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    first.unmount();
    renderWithProviders(<StripOnly view={view(1)} userRole="TENANT_ADMIN" />);
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

  it("operator: the same strip carries the sentence, the reason and the contact, with NO action button in the DOM", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={paused()} userRole="OPERATOR" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveTextContent(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment of $149.00 is overdue. To restore access, contact your admin (dana@acme.test).",
    );
    expect(within(strip).queryByRole("button", { name: /^(pay|update)/i })).toBeNull();
  });

  it("the full sentence is in the DOM and wraps: nothing is truncated or hidden behind a tap", async () => {
    renderWithProviders(<StripOnly view={view(2)} userRole="OPERATOR" />);
    const strip = await screen.findByTestId("subscription-strip");
    expect(strip).toHaveTextContent(
      "There's a billing issue. Everything still works. Your admin can sort it out in Billing.",
    );
    expect(strip.innerHTML).not.toMatch(/\btruncate\b/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("read-only strip: the three lines are stacked (sentence / reason / contact), the contact printed ONCE", async () => {
    renderWithProviders(<BillingShellBanner scope="acme" view={paused()} userRole="OPERATOR" />);
    const strip = await screen.findByTestId("subscription-strip");
    const lines = within(strip).getAllByTestId("strip-line");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent(/^This workspace is currently in read-only mode\./);
    expect(lines[1]).toHaveTextContent("Your subscription payment of $149.00 is overdue.");
    expect(lines[2]).toHaveTextContent("To restore access, contact your admin (dana@acme.test).");
    expect((strip.textContent ?? "").split("dana@acme.test")).toHaveLength(2); // exactly once
  });

  it("read-only strip, admin: sentence + reason stacked, and a >= 44 px Pay control (full width at 390)", async () => {
    renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="TENANT_ADMIN" />,
    );
    const strip = await screen.findByTestId("subscription-strip");
    expect(within(strip).getAllByTestId("strip-line")).toHaveLength(2);
    const pay = within(strip).getByRole("button", { name: /^Pay/ });
    expect(pay.className).toMatch(/min-h-\[44px\]/);
    // grows to fill the row but stays inside it: Dismiss is never pushed off the 390 px viewport (UX B4)
    expect(pay.className).toMatch(/\bflex-1\b/);
    expect(pay.className).not.toMatch(/\bw-full\b/);
  });

  it("buyers get no billing state at all, whatever the view says", () => {
    const { container } = renderWithProviders(
      <BillingShellBanner scope="acme" view={paused()} userRole="CUSTOMER" />,
    );
    expect(container.textContent ?? "").not.toMatch(/payment|billing|subscribe/i);
    expect(screen.queryByTestId("subscription-strip")).toBeNull();
  });

  it("never says overdue / failed / suspended or offers a plan purchase (read-only names the reason: SA-776)", async () => {
    for (const [v, role] of [
      [view(2), "TENANT_ADMIN"],
      [view(6), "OPERATOR"],
    ] as const) {
      const { container, unmount } = renderWithProviders(<StripOnly view={v} userRole={role} />);
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
    expect(await screen.findByText(/Your free trial has ended\./)).toBeInTheDocument();
    expect(screen.getByText(/currently in read-only mode/)).toBeInTheDocument();
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
      <StripOnly view={view(9, { pauseEnforced: false })} userRole="TENANT_ADMIN" />,
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
    expect(box!.className).toMatch(/min-h-8/);
    expect(box!.className).toMatch(/md:min-h-9/);
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

describe("SubscriptionStrip controls stay inside a 390 px row (UX B4)", () => {
  it("overdue strip, admin: Pay now flexes (flex-1 min-w-0) and Dismiss keeps its 44 px box beside it", async () => {
    renderWithProviders(
      <StripOnly
        view={view(2, { pauseEnforced: false, payNowAmount: 149, outstandingTotal: 149 })}
        userRole="TENANT_ADMIN"
      />,
    );
    const strip = await screen.findByTestId("subscription-strip");
    const pay = within(strip).getByRole("button", { name: "Pay now" });
    expect(pay.className).toMatch(/\bflex-1\b/);
    expect(pay.className).toMatch(/min-w-0/);
    expect(pay.className).not.toMatch(/\bw-full\b/);
    const dismiss = within(strip).getByRole("button", { name: "Dismiss" });
    expect(dismiss.className).toMatch(/\bshrink-0\b/);
    expect(dismiss.className).toMatch(/min-w-\[44px\]/);
  });
});
