import { ConflictException } from "@nestjs/common";
import { assertLivePaymentsAllowed } from "./live-payments-wall";

/**
 * SA-1547 F1: the api jest setup pins STRIPE_SECRET_KEY to a synthetic live-shaped value before each suite, so the
 * refusal specs never read an ambient developer key. This spec proves the pin holds: run with
 * `STRIPE_SECRET_KEY=sk_test_x npx jest <this file>` and it is still green.
 */
describe("jest STRIPE_SECRET_KEY pin (SA-1547 F1)", () => {
  it("the setup file sets a live-shaped synthetic key", () => {
    expect(process.env.STRIPE_SECRET_KEY).toBe("sk_live_jest_synthetic");
  });

  it("a non-PRODUCTION business is refused with the default (ambient) key mode", () => {
    expect(() => assertLivePaymentsAllowed("TEST")).toThrow(ConflictException);
  });
});
