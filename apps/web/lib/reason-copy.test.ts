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

import { describeDeliveryOutcome } from "./reason-copy";

describe("describeDeliveryOutcome (#1965 UX review)", () => {
  it("counts in the sentence, names skipped vs not sent, and never echoes the code", () => {
    expect(describeDeliveryOutcome("NO_FROM_ADDRESS", 2)).toBe(
      "2 emails weren't sent: no sending email address is set up.",
    );
    expect(describeDeliveryOutcome("NO_FROM_ADDRESS", 1)).toBe(
      "1 email wasn't sent: no sending email address is set up.",
    );
    expect(describeDeliveryOutcome("RULE_OFF", 3)).toBe(
      "3 emails were skipped: this notification is switched off.",
    );
    expect(describeDeliveryOutcome("SMTP 550 user unknown", 2)).toBe(
      "2 emails weren't sent for a reason we couldn't identify.",
    );
  });
});

describe("every reason code renders a whole, well-formed sentence (#1965 review)", () => {
  const EXPECTED: Record<string, string> = {
    RULE_OFF: "2 emails were skipped: this notification is switched off.",
    NO_RECIPIENT: "2 emails were skipped: the customer has no email address.",
    OPTED_OUT: "2 emails were skipped: the recipient opted out.",
    NO_FROM_ADDRESS: "2 emails weren't sent: no sending email address is set up.",
    MAILBOX_REVOKED: "2 emails weren't sent: the connected mailbox lost access.",
    SMTP_AUTH: "2 emails weren't sent: the email account sign-in was rejected.",
    TRANSPORT_ERROR: "2 emails weren't sent: the email service had a delivery problem.",
    RECIPIENT_REJECTED: "2 emails weren't sent: the recipient's mail server rejected the message.",
    UNKNOWN: "2 emails weren't sent for a reason we couldn't identify.",
  };

  it("has an expected sentence for every DELIVERY_REASON_CODE_VALUES entry (no code is unpinned)", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...DELIVERY_REASON_CODE_VALUES].sort());
    for (const code of DELIVERY_REASON_CODE_VALUES) {
      expect(describeDeliveryOutcome(code, 2)).toBe(EXPECTED[code]);
    }
  });

  it("no sentence has a dangling preposition after the colon or echoes a code", () => {
    for (const code of DELIVERY_REASON_CODE_VALUES) {
      const s = describeDeliveryOutcome(code, 2);
      expect(s).not.toMatch(/: (of|because|to|for) /);
      expect(s).not.toContain(code);
      expect(s).toMatch(/\.$/);
    }
  });
});
