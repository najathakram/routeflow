import { READ_ONLY_SENTENCE, readOnlyCopy, readOnlyCopyText } from "../lib/read-only-copy";

// SA-776: the mobile re-export of the shared composer; the strings are pinned here so a mobile surface that
// ships later cannot drift from web (the web suite pins the same strings).
describe("mobile read-only copy (SA-776)", () => {
  it("the sentence is the owner's, verbatim", () => {
    expect(READ_ONLY_SENTENCE).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.",
    );
  });

  it("maps each reason to its fixed line", () => {
    expect(readOnlyCopy({ reason: "trial_expired" }).reasonLine).toBe("Your free trial has ended.");
    expect(readOnlyCopy({ reason: "subscription_cancelled" }).reasonLine).toBe(
      "Your subscription was cancelled.",
    );
    expect(readOnlyCopy({ reason: "trial_cancelled" }).reasonLine).toBe(
      "Your subscription was cancelled.",
    );
    expect(readOnlyCopy({ reason: "payment_overdue", overdueAmount: 149 }).reasonLine).toBe(
      "Your subscription payment of $149.00 is overdue.",
    );
    expect(readOnlyCopy({ reason: "payment_overdue" }).reasonLine).toBe(
      "Your subscription payment is overdue.",
    );
    expect(readOnlyCopy({ reason: null }).reasonLine).toBeNull();
  });

  it("a non-admin sees name + email; an admin sees no contact line; email missing -> name only", () => {
    const base = { billingContactName: "Dana Reyes", billingContactEmail: "dana@acme.test" };
    expect(readOnlyCopy(base).contactLine).toBe(
      "To restore access, contact Dana Reyes (dana@acme.test).",
    );
    expect(readOnlyCopy({ ...base, isAdmin: true }).contactLine).toBeNull();
    expect(readOnlyCopy({ billingContactName: "Dana Reyes" }).contactLine).toBe(
      "To restore access, contact Dana Reyes.",
    );
    expect(readOnlyCopyText({ reason: "trial_expired", ...base })).toContain(
      "Your free trial has ended.",
    );
  });
});
