import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { render, screen } from "@testing-library/react";
import { usePaidNotice, usePaidTransition } from "./billing-paid-notice";

/**
 * SA-733r6 (B4): "You're all set. Thanks for your payment." shows ONCE on the Billing card after a payment clears -
 * including when the admin paid in Stripe and came back through a full page load. It is scoped to the tenant, and a
 * cleared marker only counts as PAID when the owed amount was known (> 0) and the workspace is back to ACTIVE: a
 * voided / written-off invoice that leaves the workspace read-only never says "thanks for your payment".
 */
const view = (
  owed: string | null,
  over: Partial<Pick<SubscriptionView, "status" | "openInvoiceAmount">> = {},
) =>
  ({
    pastDueInvoiceId: owed,
    status: "ACTIVE",
    openInvoiceAmount: owed ? 149 : null,
    ...over,
  }) as unknown as SubscriptionView;

function Watcher({
  v,
  scope = "acme",
}: {
  v: SubscriptionView | undefined;
  scope?: string | null;
}) {
  usePaidTransition(v, scope);
  return null;
}
function Card({ scope = "acme" }: { scope?: string | null }) {
  const [paid, clear] = usePaidNotice(scope);
  return paid ? (
    <button onClick={clear}>You&apos;re all set. Thanks for your payment.</button>
  ) : (
    <span>quiet</span>
  );
}
const ALL_SET = "You're all set. Thanks for your payment.";

beforeEach(() => window.localStorage.clear());

describe("paid notice", () => {
  it("in-session: owed -> cleared flags a payment, the card shows it once", () => {
    const { rerender } = render(<Watcher v={view("in_1")} />);
    rerender(<Watcher v={view(null)} />);
    const first = render(<Card />);
    expect(screen.getByText(ALL_SET)).toBeInTheDocument();
    first.unmount();
    render(<Card />);
    expect(screen.getByText("quiet")).toBeInTheDocument(); // consumed: never twice
  });

  it("survives a full reload: the owed marker was remembered, the next load sees it gone", () => {
    const first = render(<Watcher v={view("in_1")} />);
    first.unmount(); // the admin leaves for Stripe; the page is gone
    render(<Watcher v={view(null)} />); // a fresh load: the invoice is paid
    render(<Card />);
    expect(screen.getByText(ALL_SET)).toBeInTheDocument();
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

  it("a void / write-off that leaves the workspace read-only is NOT a payment", () => {
    const { rerender } = render(<Watcher v={view("in_1")} />);
    rerender(<Watcher v={view(null, { status: "READ_ONLY" })} />);
    render(<Card />);
    expect(screen.getByText("quiet")).toBeInTheDocument();
  });

  it("the remembered marker is dropped on that void, so a later healthy read cannot resurrect it", () => {
    const { rerender } = render(<Watcher v={view("in_1")} />);
    rerender(<Watcher v={view(null, { status: "READ_ONLY" })} />);
    rerender(<Watcher v={view(null)} />);
    render(<Card />);
    expect(screen.getByText("quiet")).toBeInTheDocument();
  });

  it("an owed amount that was never known (an operator's view) cannot prove a payment", () => {
    const { rerender } = render(<Watcher v={view("in_1", { openInvoiceAmount: null })} />);
    rerender(<Watcher v={view(null)} />);
    render(<Card />);
    expect(screen.getByText("quiet")).toBeInTheDocument();
  });

  it("tenant switch: tenant A's owed invoice never produces a notice for tenant B (or the reverse)", () => {
    const a = render(<Watcher v={view("in_1")} scope="acme" />);
    a.unmount();
    render(<Watcher v={view(null)} scope="globex" />); // a different workspace, nothing owed
    render(<Card scope="globex" />);
    expect(screen.getByText("quiet")).toBeInTheDocument();
    // ... and A's own memory is still there for A
    render(<Watcher v={view(null)} scope="acme" />);
    const cardA = render(<Card scope="acme" />);
    expect(cardA.container.textContent).toContain(ALL_SET);
  });

  it("no scope (the viewer is not resolved yet): nothing is remembered or flagged", () => {
    const { rerender } = render(<Watcher v={view("in_1")} scope={null} />);
    rerender(<Watcher v={view(null)} scope={null} />);
    render(<Card scope={null} />);
    expect(screen.getByText("quiet")).toBeInTheDocument();
  });
});
