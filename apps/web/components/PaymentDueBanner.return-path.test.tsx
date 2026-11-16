import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, waitFor } from "@testing-library/react";
import type { CheckoutStart, PaymentDueView } from "@routeflow/types";
import { renderWithProviders, screen } from "@/test-utils/render";
import { PaymentDueBanner } from "./PaymentDueBanner";
import { EmbeddedCheckoutHost } from "./billing/EmbeddedCheckoutHost";
import { PaidReturnNotice } from "@/app/(dashboard)/settings/billing/PaidReturnNotice";
import { shownTermsOf } from "@/lib/payment-due";
import { closeEmbeddedCheckout, getEmbeddedCheckout } from "@/lib/checkout-embedded";

/**
 * SA-1154 case table rows O2, O2h, O3, O3h: the REAL banner (its own `shownTermsOf(due)` payload), the REAL
 * `usePayPaymentDue`, the REAL host and the REAL notice. Only the network, Stripe and the router are faked. The path
 * the web pushes is the one the (faked) server answered; the web does not work it out from what it sent.
 */
const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
  },
}));
const mockGuard = jest.fn((_f?: () => void) => true);
jest.mock("@/lib/counter-cart-signal", () => ({
  guardCounterLeave: (f?: () => void) => mockGuard(f),
}));
jest.mock("@/lib/tenant-timezone", () => ({
  useTenantTimeZoneQuery: () => ({ zone: "America/New_York", isError: false, retry: jest.fn() }),
}));
const mockPush = jest.fn();
let mockSearch = "";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("@stripe/stripe-js/pure", () => ({
  loadStripe: () => Promise.resolve({ stub: true }),
}));
let mockOptions: { onComplete?: () => void } = {};
jest.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: ({
    options,
    children,
  }: {
    options: typeof mockOptions;
    children: React.ReactNode;
  }) => {
    mockOptions = options;
    return <div data-testid="stripe-provider">{children}</div>;
  },
  EmbeddedCheckout: () => <div data-testid="stripe-frame" />,
}));

const PAY = "/settings/billing?paid=1";
const CARD = "/settings/billing?paid=1&card=1";

const owed: PaymentDueView = {
  due: true,
  pastDue: true,
  amountCents: 10_000,
  periodLabel: "October 2026",
  periodStart: "2026-10-01T00:00:00.000Z",
  cardNeeded: false,
  chargeStartsOn: null,
  cardBy: null,
};
const cardReminder: PaymentDueView = {
  ...owed,
  due: false,
  pastDue: false,
  amountCents: 0,
  periodLabel: null,
  periodStart: null,
  cardNeeded: true,
  cardBy: "2026-10-29T12:00:00.000Z",
  chargeStartsOn: "2026-11-01T12:00:00.000Z",
};

const embeddedStart = (returnPath: string): CheckoutStart => ({
  uiMode: "embedded",
  sessionId: "cs_test_1",
  checkoutUrl: null,
  clientSecret: "cs_secret_test",
  returnPath,
});
const hostedStart: CheckoutStart = {
  uiMode: "hosted",
  sessionId: "cs_test_2",
  checkoutUrl: "https://pay.test/cs_test_2",
  clientSecret: null,
  returnPath: null,
};

function mountBanner(mode: "payment-due" | "card-reminder", due: PaymentDueView) {
  return renderWithProviders(
    <>
      <PaymentDueBanner mode={mode} due={due} role="admin" />
      <EmbeddedCheckoutHost />
    </>,
  );
}

/** Stripe finishes the form: the host pushes whatever path it holds. Returns the path pushed. */
async function complete(): Promise<string> {
  await screen.findByTestId("stripe-frame");
  act(() => mockOptions.onComplete?.());
  expect(mockPush).toHaveBeenCalledTimes(1);
  return mockPush.mock.calls[0][0] as string;
}

/** What the billing page's notice reads on the page the push lands on. */
function noticeAt(path: string) {
  mockSearch = path.split("?")[1] ?? "";
  mockGet.mockResolvedValue({ data: { billingState: "current" } });
  return renderWithProviders(<PaidReturnNotice />);
}

let errSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  closeEmbeddedCheckout();
  mockSearch = "";
  mockOptions = {};
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_placeholder";
  // jsdom logs "Not implemented: navigation" when a hosted start leaves the page
  errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  errSpy.mockRestore();
});

describe("O2: the payment-due Pay now (embedded)", () => {
  it("sends the banner's own shown terms and returns where the server said: ?paid=1", async () => {
    mockPost.mockResolvedValue({ data: embeddedStart(PAY) });
    mountBanner("payment-due", owed);
    await userEvent.click(screen.getByRole("button", { name: "Pay now" }));
    expect(mockPost).toHaveBeenCalledWith("/billing/payment-due/pay", {
      shown: shownTermsOf(owed),
    });
    expect(await complete()).toBe(PAY);
  });

  it("the notice on that return says Payment received once the server state is current", async () => {
    mockPost.mockResolvedValue({ data: embeddedStart(PAY) });
    mountBanner("payment-due", owed);
    await userEvent.click(screen.getByRole("button", { name: "Pay now" }));
    const path = await complete();
    noticeAt(path);
    expect(await screen.findByText("Payment received.")).toBeInTheDocument();
  });
});

describe("O3: the card reminder Add card (embedded)", () => {
  it("sends the banner's own shown terms ({0, null, cardBy}) and returns where the server said: ?paid=1&card=1", async () => {
    mockPost.mockResolvedValue({ data: embeddedStart(CARD) });
    mountBanner("card-reminder", cardReminder);
    await userEvent.click(screen.getByRole("button", { name: "Add card" }));
    expect(mockPost).toHaveBeenCalledWith("/billing/payment-due/pay", {
      shown: { amountCents: 0, periodStart: null, cardBy: "2026-10-29T12:00:00.000Z" },
    });
    expect(mockPost.mock.calls[0][1]).toEqual({ shown: shownTermsOf(cardReminder) });
    expect(await complete()).toBe(CARD);
  });

  it("the notice on that return says Card added and never Payment received", async () => {
    mockPost.mockResolvedValue({ data: embeddedStart(CARD) });
    mountBanner("card-reminder", cardReminder);
    await userEvent.click(screen.getByRole("button", { name: "Add card" }));
    const path = await complete();
    noticeAt(path);
    expect(
      await screen.findByText("Card added. It can take a few minutes to confirm."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Payment received.")).toBeNull();
  });
});

describe("O2h and O3h: hosted keeps Stripe's own redirect (returnPath null, no panel, no push)", () => {
  it.each([
    ["O2h payment-due Pay now", "payment-due" as const, owed, "Pay now"],
    ["O3h card reminder Add card", "card-reminder" as const, cardReminder, "Add card"],
  ])("%s", async (_name, mode, view, button) => {
    mockPost.mockResolvedValue({ data: hostedStart });
    mountBanner(mode, view);
    await userEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(mockGuard).toHaveBeenCalledTimes(1)); // the redirect's own leave guard ran
    expect(getEmbeddedCheckout()).toBeNull();
    expect(screen.queryByTestId("stripe-frame")).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
