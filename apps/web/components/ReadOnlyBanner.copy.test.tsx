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

describe("ReadOnlyBanner layout (UX QA): stacked lines, a >= 44 px admin control", () => {
  it("stacks the owner's sentence, the reason and the contact as separate lines, the contact once", () => {
    const { container } = render(
      <ReadOnlyBanner
        status="READ_ONLY"
        readOnlyReason="payment_overdue"
        overdueAmount={149}
        billingContactEmail="dana@acme.test"
        isAdmin={false}
      />,
    );
    const lines = container.querySelectorAll("[data-testid=read-only-line-part]");
    expect(lines).toHaveLength(3);
    expect(lines[1].textContent?.trim()).toBe("Your subscription payment of $149.00 is overdue.");
    expect(lines[2].textContent?.trim()).toBe(
      "To restore access, contact your admin (dana@acme.test).",
    );
    expect((container.textContent ?? "").split("dana@acme.test")).toHaveLength(2);
  });

  it("the admin's Choose a plan is a full-width (at 390) >= 44 px control", () => {
    render(<ReadOnlyBanner status="READ_ONLY" readOnlyReason="trial_expired" isAdmin />);
    const link = screen.getByRole("link", { name: "Choose a plan" });
    expect(link.className).toMatch(/min-h-\[44px\]/);
    expect(link.className).toMatch(/\bw-full\b/);
  });
});

describe("ReadOnlyBanner admin action by reason (F1/F2, billing-ux §4)", () => {
  it.each(["subscription_cancelled", "trial_cancelled", "payment_overdue", null, "set_by_admin"])(
    "reason %s: a 'Billing' link to /settings/billing (never 'Choose a plan'), a >= 44 px control",
    (reason) => {
      render(<ReadOnlyBanner status="READ_ONLY" readOnlyReason={reason} isAdmin />);
      const link = screen.getByRole("link", { name: "Billing" });
      expect(link).toHaveAttribute("href", "/settings/billing");
      expect(link.className).toMatch(/min-h-\[44px\]/);
      expect(screen.queryByRole("link", { name: "Choose a plan" })).toBeNull();
    },
  );

  it("trial_expired keeps 'Choose a plan' (the plan choice flow), a >= 44 px control", () => {
    render(<ReadOnlyBanner status="READ_ONLY" readOnlyReason="trial_expired" isAdmin />);
    const link = screen.getByRole("link", { name: "Choose a plan" });
    expect(link).toHaveAttribute("href", "/choose-plan");
    expect(link.className).toMatch(/min-h-\[44px\]/);
  });
});
