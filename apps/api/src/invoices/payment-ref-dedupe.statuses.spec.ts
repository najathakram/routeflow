import { PaymentStatus } from "@prisma/client";
import { DEDUPE_STATUSES } from "@routeflow/pricing";

/**
 * Exhaustive over the Prisma enum: a fifth PaymentStatus value fails the type check (missing key) and the
 * second test until it is classified here and, if deduped, added to DEDUPE_STATUSES.
 */
const CLASSIFICATION: Record<PaymentStatus, "deduped" | "not-deduped"> = {
  PAID: "deduped",
  PENDING: "deduped",
  DRAFT: "deduped",
  VOID: "not-deduped",
};

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("payment-ref dedupe status set", () => {
  it("DEDUPE_STATUSES equals the statuses classified as deduped", () => {
    const deduped = Object.entries(CLASSIFICATION)
      .filter(([, v]) => v === "deduped")
      .map(([k]) => k);
    expect(sorted(DEDUPE_STATUSES)).toEqual(sorted(deduped));
  });

  it("the classification covers every PaymentStatus value", () => {
    expect(sorted(Object.keys(CLASSIFICATION))).toEqual(sorted(Object.values(PaymentStatus)));
  });
});
