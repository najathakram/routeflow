import { profileErrorCopy } from "./profile-errors";

const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });
const labels: Record<string, string> = {
  recurring_routes: "Recurring routes",
  order_delivery: "Order delivery",
};
const labelOf = (k: string) => labels[k];

describe("profileErrorCopy: fixed copy by code, never the server message", () => {
  it("FULFILMENT_MODE_NEEDS_FLEET names BOTH fleet features by label (any one is enough)", () => {
    const out = profileErrorCopy(
      err(409, {
        code: "FULFILMENT_MODE_NEEDS_FLEET",
        key: "fulfilment_model",
        mode: "delivery",
        missing: ["recurring_routes", "order_delivery"],
        message: "raw server text",
      }),
      "fallback",
      labelOf,
    );
    expect(out).toBe(
      "Delivery needs a fleet feature turned on first: Recurring routes or Order delivery. Any one is enough.",
    );
    expect(out).not.toMatch(/raw server text|recurring_routes|order_delivery/);
  });

  it("an unknown feature key is never shown raw: generic fleet copy", () => {
    const out = profileErrorCopy(
      err(409, { code: "FULFILMENT_MODE_NEEDS_FLEET", missing: ["mystery_key"] }),
      "fallback",
      labelOf,
    );
    expect(out).toBe("Delivery needs a fleet feature turned on first.");
  });

  it("FEATURE_MODE_REQUIRES (a single string `missing`) names the label; none known -> generic", () => {
    expect(
      profileErrorCopy(
        err(409, { code: "FEATURE_MODE_REQUIRES", missing: "order_delivery" }),
        "f",
        labelOf,
      ),
    ).toBe("This needs Order delivery turned on first.");
    expect(profileErrorCopy(err(409, { code: "FEATURE_MODE_REQUIRES" }), "f", labelOf)).toMatch(
      /needs a feature this tenant does not have/,
    );
  });

  it("profile codes, a missing tenant and an unknown failure", () => {
    expect(
      profileErrorCopy(err(400, { code: "BUSINESS_PROFILE_UNKNOWN", message: "x" }), "f"),
    ).toBe("That business profile does not exist.");
    expect(profileErrorCopy(err(409, { code: "BUSINESS_PROFILE_UNAVAILABLE" }), "f")).toBe(
      "That business profile is not available yet.",
    );
    expect(profileErrorCopy(err(404, { message: "Tenant not found" }), "f")).toBe(
      "That tenant was not found.",
    );
    expect(profileErrorCopy(new Error("boom"), "fallback")).toBe("fallback");
  });
});
