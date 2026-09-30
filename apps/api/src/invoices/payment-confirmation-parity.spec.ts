import { PaymentMethod, PaymentStatus } from "@prisma/client";
import { ADVANCE_METHOD, CONFIRMED_STATUS, CREDIT_NOTE_METHOD } from "@routeflow/pricing";

/**
 * `@routeflow/pricing` cannot import `@prisma/client` (it must stay
 * dependency-free so every workspace can import it — see
 * `payment-confirmation.ts`'s header), so its `CONFIRMED_STATUS`/
 * `CREDIT_NOTE_METHOD`/`ADVANCE_METHOD` are plain string literals, not a
 * reference to the real enum. This is the API-side pin (the API is the one
 * place Prisma is available) proving those literals stay real, current
 * members of the live `PaymentStatus`/`PaymentMethod` enums — a renamed or
 * retired Prisma value would otherwise silently desync the pricing package's
 * copy with no compiler error (both are just `string`).
 */
describe("payment-confirmation constants stay pinned to the live Prisma enums", () => {
  it("CONFIRMED_STATUS is a real PaymentStatus member", () => {
    expect(Object.values(PaymentStatus)).toContain(CONFIRMED_STATUS);
  });

  it("CREDIT_NOTE_METHOD and ADVANCE_METHOD are real PaymentMethod members", () => {
    expect(Object.values(PaymentMethod)).toContain(CREDIT_NOTE_METHOD);
    expect(Object.values(PaymentMethod)).toContain(ADVANCE_METHOD);
  });
});
