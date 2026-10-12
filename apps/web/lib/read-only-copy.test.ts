import type { SubscriptionView } from "@routeflow/types";
import {
  READ_ONLY_SENTENCE,
  readOnlyCopy,
  readOnlyCopyForView,
  readOnlyCopyText,
} from "./read-only-copy";

const SENTENCE =
  "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.";

describe("read-only copy (SA-776)", () => {
  it("the sentence is the owner's, verbatim", () => {
    expect(READ_ONLY_SENTENCE).toBe(SENTENCE);
    expect(readOnlyCopy({}).sentence).toBe(SENTENCE);
  });

  it.each([
    ["trial_expired", "Your free trial has ended."],
    ["subscription_cancelled", "Your subscription was cancelled."],
    ["trial_cancelled", "Your subscription was cancelled."],
    ["payment_overdue", "Your subscription payment is overdue."],
  ])("reason %s maps to one fixed line", (reason, line) => {
    expect(readOnlyCopy({ reason }).reasonLine).toBe(line);
  });

  it("an amount owed is printed through the shared money formatter", () => {
    expect(readOnlyCopy({ reason: "payment_overdue", overdueAmount: 149 }).reasonLine).toBe(
      "Your subscription payment of $149.00 is overdue.",
    );
    expect(readOnlyCopy({ reason: "payment_overdue", overdueAmount: 1490.5 }).reasonLine).toBe(
      "Your subscription payment of $1,490.50 is overdue.",
    );
  });

  it("a null reason (set by an administrator) and an unknown reason carry NO reason line", () => {
    expect(readOnlyCopy({ reason: null }).reasonLine).toBeNull();
    expect(readOnlyCopy({ reason: "set by ops: pending audit" }).reasonLine).toBeNull();
    // server text is never echoed
    expect(readOnlyCopyText({ reason: "set by ops: pending audit" })).toBe(SENTENCE);
  });

  it("a non-admin gets the contact line: 'your admin' and the e-mail, never a name", () => {
    const c = readOnlyCopy({
      reason: "trial_expired",
      billingContactEmail: "dana@acme.test",
    });
    expect(c.contactLine).toBe("To restore access, contact your admin (dana@acme.test).");
    expect(c.text).toBe(
      `${SENTENCE} Your free trial has ended. To restore access, contact your admin (dana@acme.test).`,
    );
    expect(c.lines).toEqual([SENTENCE, "Your free trial has ended.", c.contactLine]);
  });

  it("a TENANT_ADMIN gets no contact line (the caller renders the action instead)", () => {
    const c = readOnlyCopy({
      reason: "trial_expired",
      billingContactEmail: "dana@acme.test",
      isAdmin: true,
    });
    expect(c.contactLine).toBeNull();
    expect(c.text).toBe(`${SENTENCE} Your free trial has ended.`);
  });

  it("no e-mail on file omits the contact line (no username, no name is ever shown)", () => {
    expect(readOnlyCopy({}).contactLine).toBeNull();
    expect(readOnlyCopy({ billingContactEmail: "  " }).contactLine).toBeNull();
    expect(readOnlyCopy({ billingContactEmail: null }).lines).toEqual([SENTENCE]);
    // an extra name key is not part of the input shape and changes nothing
    const withName = { billingContactEmail: "dana@acme.test", billingContactName: "dana_admin" };
    expect(readOnlyCopy(withName).text).not.toContain("dana_admin");
  });

  it("composes from the subscription view", () => {
    const view = {
      status: "READ_ONLY",
      readOnlyReason: "payment_overdue",
      openInvoiceAmount: 149,
      billingContactEmail: "dana@acme.test",
    } as unknown as SubscriptionView;
    expect(readOnlyCopyForView(view, false).text).toBe(
      `${SENTENCE} Your subscription payment of $149.00 is overdue. To restore access, contact your admin (dana@acme.test).`,
    );
    expect(readOnlyCopyForView(view, true).contactLine).toBeNull();
    expect(readOnlyCopyForView(null, false).text).toBe(SENTENCE);
  });
});
