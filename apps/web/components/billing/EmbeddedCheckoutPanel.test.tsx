import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, waitFor } from "@testing-library/react";
import { EmbeddedCheckoutPanel } from "./EmbeddedCheckoutPanel";

/**
 * SA-1154: a Stripe.js that cannot load (script blocked, offline, no key) ends in the failed line, and its rejection
 * is caught inside the panel, so neither the panel nor Stripe's React provider leaves an unhandled rejection.
 */
let mockLoad: () => Promise<unknown> = () => Promise.resolve({ stub: true });
jest.mock("@stripe/stripe-js/pure", () => ({ loadStripe: () => mockLoad() }));
let received: Promise<unknown> | null = null;
jest.mock("@stripe/react-stripe-js", () => ({
  EmbeddedCheckoutProvider: ({
    stripe,
    children,
  }: {
    stripe: Promise<unknown>;
    children: React.ReactNode;
  }) => {
    received = stripe;
    return <div data-testid="stripe-provider">{children}</div>;
  },
  EmbeddedCheckout: () => <div data-testid="stripe-frame" />,
}));

const FAILED = "The payment form didn't load. Nothing was charged.";

describe("EmbeddedCheckoutPanel load states", () => {
  beforeEach(() => {
    received = null;
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_placeholder";
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  });

  it("says it is loading until Stripe.js is ready", async () => {
    render(
      <EmbeddedCheckoutPanel
        clientSecret="cs_secret_1"
        onBack={jest.fn()}
        onComplete={jest.fn()}
      />,
    );
    expect(screen.getByText("Loading the payment form…")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Loading the payment form…")).toBeNull());
    expect(screen.getByTestId("stripe-frame")).toBeInTheDocument();
  });

  it("a Stripe.js that fails to load shows the failed line with Back, and the rejection is caught", async () => {
    mockLoad = () => Promise.reject(new Error("blocked"));
    const onBack = jest.fn();
    render(
      <EmbeddedCheckoutPanel clientSecret="cs_secret_2" onBack={onBack} onComplete={jest.fn()} />,
    );
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByTestId("stripe-frame")).toBeNull();
    // what Stripe's own provider is handed settles to null: it has nothing to reject unhandled
    await expect(received).resolves.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    mockLoad = () => Promise.resolve({ stub: true });
  });

  it("a Stripe.js that resolves to nothing (no key, no window) reads the same", async () => {
    mockLoad = () => Promise.resolve(null);
    render(
      <EmbeddedCheckoutPanel
        clientSecret="cs_secret_3"
        onBack={jest.fn()}
        onComplete={jest.fn()}
      />,
    );
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    mockLoad = () => Promise.resolve({ stub: true });
  });
});
