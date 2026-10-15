import { API_ERROR_CODES } from "@routeflow/types";
import { profileErrorCopy } from "./profile-errors";

const FALLBACK = "Could not apply that business profile. Try again.";

/** An axios-shaped failure: `response.data` is the API's JSON body. */
function apiError(status: number, data: Record<string, unknown>) {
  return { response: { status, data } };
}

describe("profileErrorCopy — fixed copy chosen by the API's error code", () => {
  it("never shows the server's own message text", () => {
    const copy = profileErrorCopy(
      apiError(500, { code: "SOMETHING_NEW", message: "ECONNRESET stripe.com sk_live_123" }),
      FALLBACK,
    );
    expect(copy).toBe(FALLBACK);
    expect(copy).not.toMatch(/ECONNRESET|stripe|sk_live/);
  });

  it("BUSINESS_PROFILE_UNKNOWN → a fixed 'does not exist' line", () => {
    expect(
      profileErrorCopy(
        apiError(400, { code: API_ERROR_CODES.BUSINESS_PROFILE_UNKNOWN, message: "x is not one" }),
        FALLBACK,
      ),
    ).toBe("That business profile does not exist.");
  });

  it("BUSINESS_PROFILE_UNAVAILABLE → says in-store profiles open with counter sales", () => {
    expect(
      profileErrorCopy(
        apiError(400, {
          code: API_ERROR_CODES.BUSINESS_PROFILE_UNAVAILABLE,
          profile: "in_store_retailer",
          unavailable: [{ key: "fulfilment_model", mode: "pickup" }],
          message: "not available yet",
        }),
        FALLBACK,
      ),
    ).toBe("This business profile isn't available for this tenant.");
  });

  it("FULFILMENT_MODE_NEEDS_FLEET → names the fleet features, never raw keys", () => {
    const copy = profileErrorCopy(
      apiError(409, {
        code: API_ERROR_CODES.FULFILMENT_MODE_NEEDS_FLEET,
        key: "fulfilment_model",
        mode: "delivery",
        missing: ["recurring_routes", "order_delivery", "mystery_key"],
      }),
      FALLBACK,
    );
    expect(copy).toBe(
      "Delivery needs a fleet feature turned on first: Recurring routes or Ad hoc order delivery. Any one is enough.",
    );
    expect(copy).not.toMatch(/mystery_key|recurring_routes|order_delivery/);
  });

  it("FEATURE_MODE_REQUIRES → names the missing feature, or a generic phrase for an unknown key", () => {
    expect(
      profileErrorCopy(
        apiError(409, { code: API_ERROR_CODES.FEATURE_MODE_REQUIRES, missing: "order_delivery" }),
        FALLBACK,
      ),
    ).toBe("This needs Ad hoc order delivery turned on first.");
    expect(
      profileErrorCopy(
        apiError(409, { code: API_ERROR_CODES.FEATURE_MODE_REQUIRES, missing: "zzz_key" }),
        FALLBACK,
      ),
    ).toBe("This needs a feature turned on first.");
  });

  it("404 → tenant not found; 403 → admin only", () => {
    expect(profileErrorCopy(apiError(404, { message: "Tenant t not found" }), FALLBACK)).toBe(
      "That tenant was not found.",
    );
    expect(profileErrorCopy(apiError(403, { message: "Forbidden" }), FALLBACK)).toBe(
      "Only platform admins can change a business profile.",
    );
  });

  it("a network failure with no response falls back", () => {
    expect(profileErrorCopy(new Error("Network Error"), FALLBACK)).toBe(FALLBACK);
    expect(profileErrorCopy(undefined, FALLBACK)).toBe(FALLBACK);
  });

  describe("BUSINESS_PROFILE_BILLING_FAILED (503)", () => {
    const code = API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED;

    it("billing step, nothing stopped yet → 'not applied, nothing changed'", () => {
      expect(
        profileErrorCopy(
          apiError(503, {
            code,
            featureKey: "driver_payments",
            alreadyDisabled: [],
            failedStep: { step: "billing", key: "driver_payments" },
            message: "Stripe said no: card_declined",
          }),
          FALLBACK,
        ),
      ).toBe(
        "The business profile was not applied: billing for At-door payment collection could not be stopped. Nothing was changed. Try again.",
      );
    });

    it("billing step after some add-ons were already switched off → names exactly which", () => {
      const copy = profileErrorCopy(
        apiError(503, {
          code,
          featureKey: "recurring_routes",
          alreadyDisabled: ["driver_payments", "order_delivery"],
          failedStep: { step: "billing", key: "recurring_routes" },
        }),
        FALLBACK,
      );
      expect(copy).toBe(
        "The business profile was only partly applied. Billing was already stopped for At-door payment collection and Ad hoc order delivery, but not for Recurring routes. Try again to finish.",
      );
    });

    it("a later step failing after billing stopped → says billing is already stopped and which step failed", () => {
      expect(
        profileErrorCopy(
          apiError(503, {
            code,
            featureKey: "fulfilment_model",
            alreadyDisabled: ["driver_payments"],
            failedStep: { step: "mode", key: "fulfilment_model" },
          }),
          FALLBACK,
        ),
      ).toBe(
        "The business profile was only partly applied. Billing was already stopped for At-door payment collection, then saving the fulfilment model failed. Try again to finish.",
      );
      expect(
        profileErrorCopy(
          apiError(503, {
            code,
            alreadyDisabled: ["order_delivery"],
            failedStep: { step: "audit", key: "shipping_wholesaler" },
          }),
          FALLBACK,
        ),
      ).toBe(
        "The business profile was only partly applied. Billing was already stopped for Ad hoc order delivery, then recording the change failed. Try again to finish.",
      );
    });

    it("never prints a raw key or the server message, even for an unknown key or a malformed body", () => {
      const copy = profileErrorCopy(
        apiError(503, {
          code,
          alreadyDisabled: ["secret_addon_key"],
          failedStep: { step: "grant", key: "secret_addon_key" },
          message: "Stripe error sub_1Abc",
        }),
        FALLBACK,
      );
      expect(copy).not.toMatch(/secret_addon_key|sub_1Abc|Stripe/);
      expect(copy).toContain("Try again to finish.");
      // No usable body at all → still the coded line, never the fallback that hides a partial apply.
      expect(profileErrorCopy(apiError(503, { code }), FALLBACK)).toBe(
        "The business profile could not be applied because billing could not be stopped. Check the tenant's setup, then try again.",
      );
    });
  });
});

describe("BUSINESS_PROFILE_BILLING_FAILED with the per-add-on list (ROW c)", () => {
  const code = API_ERROR_CODES.BUSINESS_PROFILE_BILLING_FAILED;
  const item = (key: string, wasComp: boolean, billingStopped: boolean, switchedOff: boolean) => ({
    key,
    wasComp,
    billingStopped,
    switchedOff,
  });
  const copyFor = (addons: unknown, extra: Record<string, unknown> = {}) =>
    profileErrorCopy(
      apiError(503, {
        code,
        message: "Stripe error sub_1Abc",
        alreadyDisabled: [],
        failedStep: { step: "billing", key: "recurring_routes" },
        ...extra,
        addons,
      }),
      FALLBACK,
    );

  it("a paid row whose billing was stopped says 'Billing stopped for X'", () => {
    const copy = copyFor([item("driver_payments", false, true, true)], {
      alreadyDisabled: ["driver_payments"],
      failedStep: { step: "mode", key: "fulfilment_model" },
    });
    expect(copy).toContain("Billing stopped for At-door payment collection.");
    expect(copy).not.toMatch(/sub_1Abc|Stripe|driver_payments/);
  });

  it("a comp row says 'X switched off' and never mentions billing for it", () => {
    const copy = copyFor([item("order_delivery", true, false, true)], {
      alreadyDisabled: ["order_delivery"],
      failedStep: { step: "mode", key: "fulfilment_model" },
    });
    expect(copy).toContain("Ad hoc order delivery switched off.");
    expect(copy).not.toMatch(/[Bb]illing/);
  });

  it("a paid row whose stop failed says it could not be stopped and is still on", () => {
    const copy = copyFor([item("recurring_routes", false, false, false)]);
    expect(copy).toContain("Billing for Recurring routes could not be stopped; it's still on.");
  });

  it("a comp row whose switch-off failed says it could not be switched off and is still on", () => {
    const copy = copyFor([item("recurring_routes", true, false, false)]);
    expect(copy).toContain("Recurring routes could not be switched off; it's still on.");
    expect(copy).not.toMatch(/[Bb]illing/);
  });

  it("mixed: failed items first, each in its own phrasing, then the retry line", () => {
    const copy = copyFor(
      [
        item("driver_payments", false, true, true),
        item("recurring_routes", true, false, false),
        item("order_delivery", true, false, true),
      ],
      { alreadyDisabled: ["driver_payments", "order_delivery"] },
    );
    expect(copy).toBe(
      "The business profile was only partly applied. " +
        "Recurring routes could not be switched off; it's still on. " +
        "Billing stopped for At-door payment collection. " +
        "Ad hoc order delivery switched off. " +
        "Try again to finish.",
    );
  });

  it("nothing switched off yet: 'not applied' and no 'partly'", () => {
    const copy = copyFor([item("recurring_routes", false, false, false)]);
    expect(copy).toBe(
      "The business profile was not applied. Billing for Recurring routes could not be stopped; it's still on. Nothing was changed. Try again.",
    );
  });

  it("a later step failed: the step is named after the per-add-on lines", () => {
    const copy = copyFor([item("driver_payments", false, true, true)], {
      alreadyDisabled: ["driver_payments"],
      failedStep: { step: "mode", key: "fulfilment_model" },
    });
    expect(copy).toBe(
      "The business profile was only partly applied. Billing stopped for At-door payment collection. Then saving the fulfilment model failed. Try again to finish.",
    );
  });

  it("an unknown key becomes 'Another add-on', never the raw key; malformed items are skipped", () => {
    const copy = copyFor([item("secret_addon_key", true, false, true), { key: 42 }, null, "x"]);
    expect(copy).toContain("Another add-on switched off.");
    expect(copy).not.toMatch(/secret_addon_key/);
  });

  it("an empty or missing list falls back to the older alreadyDisabled copy", () => {
    expect(copyFor([], { alreadyDisabled: ["driver_payments"] })).toContain(
      "Billing was already stopped for At-door payment collection",
    );
  });
});
