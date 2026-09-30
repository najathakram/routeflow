import * as fs from "fs";
import * as path from "path";
import {
  DELIVERY_FIX_LINK_VALUES,
  DELIVERY_REASON_CODE_VALUES,
  deliveryFixTarget,
  describeDeliveryReason,
} from "./reason-copy";

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

  it("T15c every fix-link resolves to its exact settings section (keys exist in settings/page.tsx SECTIONS)", () => {
    expect(deliveryFixTarget("NONE")).toBeNull();
    expect(deliveryFixTarget("SETTINGS_EMAIL")?.href).toBe("/settings?tab=email");
    expect(deliveryFixTarget("SETTINGS_NOTIFICATIONS")?.href).toBe("/settings?tab=notifications");
    expect(deliveryFixTarget("MY_ACCOUNT")?.href).toBe("/settings?tab=account");
    const page = fs.readFileSync(
      path.resolve(__dirname, "../app/(dashboard)/settings/page.tsx"),
      "utf8",
    );
    for (const v of DELIVERY_FIX_LINK_VALUES) {
      const key = deliveryFixTarget(v)?.href.split("tab=")[1];
      if (key) expect(page).toMatch(new RegExp("^\\s+" + key + ": \\{", "m"));
    }
  });
});
