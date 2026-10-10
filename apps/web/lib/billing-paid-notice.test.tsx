import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { render, screen } from "@testing-library/react";
import { usePaidNotice, usePaidTransition } from "./billing-paid-notice";

/**
 * SA-733r6 (B4): "You're all set. Thanks for your payment." shows ONCE on the Billing card after a payment clears -
 * including when the admin paid in Stripe and came back through a full page load.
 */
const view = (owed: string | null) => ({ pastDueInvoiceId: owed }) as unknown as SubscriptionView;

function Watcher({ v }: { v: SubscriptionView | undefined }) {
  usePaidTransition(v);
  return null;
}
function Card() {
  const [paid, clear] = usePaidNotice();
  return paid ? (
    <button onClick={clear}>You&apos;re all set. Thanks for your payment.</button>
  ) : (
    <span>quiet</span>
  );
}

beforeEach(() => window.localStorage.clear());

describe("paid notice", () => {
  it("in-session: owed -> cleared flags a payment, the card shows it once", () => {
    const { rerender } = render(<Watcher v={view("in_1")} />);
    rerender(<Watcher v={view(null)} />);
    const first = render(<Card />);
    expect(screen.getByText("You're all set. Thanks for your payment.")).toBeInTheDocument();
    first.unmount();
    render(<Card />);
    expect(screen.getByText("quiet")).toBeInTheDocument(); // consumed: never twice
  });

  it("survives a full reload: the owed marker was remembered, the next load sees it gone", () => {
    const first = render(<Watcher v={view("in_1")} />);
    first.unmount(); // the admin leaves for Stripe; the page is gone
    render(<Watcher v={view(null)} />); // a fresh load: the invoice is paid
    render(<Card />);
    expect(screen.getByText("You're all set. Thanks for your payment.")).toBeInTheDocument();
  });

  it("a workspace that never owed anything never shows it", () => {
    render(<Watcher v={view(null)} />);
    render(<Card />);
    expect(screen.getByText("quiet")).toBeInTheDocument();
  });

  it("an unloaded view changes nothing", () => {
    const { rerender } = render(<Watcher v={view("in_1")} />);
    rerender(<Watcher v={undefined} />);
    render(<Card />);
    expect(screen.getByText("quiet")).toBeInTheDocument();
  });
});
