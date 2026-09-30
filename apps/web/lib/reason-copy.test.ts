import { DELIVERY_FIX_LINK_VALUES, DELIVERY_REASON_CODE_VALUES } from "@routeflow/types";
import { deliveryFixTarget, describeDeliveryReason } from "./reason-copy";

describe("reason-copy (#1965)", () => {
  it("T15 every closed reason code has a sentence that does not echo the code", () => {
    for (const code of DELIVERY_REASON_CODE_VALUES) {
      const s = describeDeliveryReason(code);
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toContain(code);
    }
  });

  it("T15b an unknown/raw code falls back to a generic sentence and never echoes the input", () => {
    const s = describeDeliveryReason("SMTP 550 5.1.1 user unknown");
    expect(s).not.toMatch(/smtp|550/i);
    expect(s.length).toBeGreaterThan(10);
  });

  it("T15c every fix-link value resolves (NONE -> null, others -> label + /settings href)", () => {
    for (const v of DELIVERY_FIX_LINK_VALUES) {
      const t = deliveryFixTarget(v);
      if (v === "NONE") expect(t).toBeNull();
      else expect(t?.href).toMatch(/^\/settings/);
    }
  });
});
