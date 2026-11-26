import { StripeService } from "./stripe.service";

/** SA-1547 S5: the ONE `keyMode` getter, taken from the configured secret key's prefix; anything else fails closed. */
describe("StripeService.keyMode", () => {
  const withKey = (secretKey: string | undefined) =>
    new StripeService({ get: () => ({ secretKey }) } as any);

  it.each([
    ["sk_live_x", "live"],
    ["rk_live_x", "live"],
    ["sk_test_x", "test"],
    ["rk_test_x", "test"],
    ["", "none"],
    [undefined, "none"],
    ["not_a_key", "none"],
  ])("key %p -> %s", (key, mode) => {
    expect(withKey(key as string | undefined).keyMode).toBe(mode);
  });

  it("a missing stripe config block is none", () => {
    expect(new StripeService({ get: () => undefined } as any).keyMode).toBe("none");
  });
});
