import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { ReadOnlyBanner } from "./ReadOnlyBanner";

/**
 * SA-776: the banner renders the owner's sentence + the mapped reason + the contact line (a non-admin) or the
 * action (a TENANT_ADMIN), composed in lib/read-only-copy.ts - never server text.
 */
afterEach(cleanup);

const SENTENCE =
  "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.";
const CONTACT = "To restore access, contact your admin (dana@acme.test).";

describe("ReadOnlyBanner copy (SA-776)", () => {
  it.each([
    ["trial_expired", "Your free trial has ended."],
    ["trial_cancelled", "Your subscription was cancelled."],
    ["subscription_cancelled", "Your subscription was cancelled."],
    ["payment_overdue", "Your subscription payment is overdue."],
  ])("%s: sentence + reason + contact for a non-admin, no action", (reason, line) => {
    const { container } = render(
      <ReadOnlyBanner
        status="READ_ONLY"
        readOnlyReason={reason}
        billingContactEmail="dana@acme.test"
        isAdmin={false}
      />,
    );
    expect(container.textContent).toBe(`${SENTENCE} ${line} ${CONTACT}`);
    expect(screen.queryByRole("link", { name: "Choose a plan" })).toBeNull();
  });

  it("the amount owed is printed through the money formatter (admin)", () => {
    const { container } = render(
      <ReadOnlyBanner
        status="READ_ONLY"
        readOnlyReason="payment_overdue"
        overdueAmount={149}
        billingContactEmail="dana@acme.test"
        isAdmin
      />,
    );
    expect(container.textContent).toContain("Your subscription payment of $149.00 is overdue.");
  });

  it("a TENANT_ADMIN sees the action instead of the contact line", () => {
    const { container } = render(
      <ReadOnlyBanner
        status="READ_ONLY"
        readOnlyReason="trial_expired"
        billingContactEmail="dana@acme.test"
        isAdmin
      />,
    );
    expect(container.textContent).toBe(`${SENTENCE} Your free trial has ended. Choose a plan`);
    expect(screen.getByRole("link", { name: "Choose a plan" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("To restore access");
  });

  it("a null reason (set by an administrator) carries no reason line; unknown server text is never shown", () => {
    const { container } = render(
      <ReadOnlyBanner
        status="READ_ONLY"
        readOnlyReason="paused by ops for audit"
        billingContactEmail="dana@acme.test"
        isAdmin={false}
      />,
    );
    expect(container.textContent).toBe(`${SENTENCE} ${CONTACT}`);
  });

  it("no e-mail on file: no contact line, and never a username or name", () => {
    const { container } = render(
      <ReadOnlyBanner
        status="READ_ONLY"
        readOnlyReason="trial_expired"
        billingContactEmail={null}
        isAdmin={false}
      />,
    );
    expect(container.textContent).toBe(`${SENTENCE} Your free trial has ended.`);
  });

  it("renders nothing while the workspace is not read-only", () => {
    const { container } = render(<ReadOnlyBanner status="ACTIVE" />);
    expect(container.textContent).toBe("");
  });
});
