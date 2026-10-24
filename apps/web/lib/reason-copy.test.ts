import * as fs from "fs";
import { RUN_UNFINALIZED_PREFIX } from "./api/invoices";
import * as path from "path";
import {
  DELIVERY_FIX_LINK_VALUES,
  DELIVERY_REASON_CODE_VALUES,
  deliveryFixTarget,
  describeDeliveryReason,
  returnReasonOptions,
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

import { RETURN_REASON_VALUES } from "@routeflow/types";
import {
  RECORDS_FAILED_COPY,
  SCAN_FAILED_COPY,
  describeReturnReason,
  describeRunFailure,
  describeSaveError,
} from "./reason-copy";

describe("reason-copy: run failures, return reasons, save errors (#1965)", () => {
  it("describeRunFailure: the unfinalized prefix is never retryable and never echoes the server text", () => {
    const r = describeRunFailure(
      "The invoice was created but the run could not be finalized (invoice abc): P2002 boom",
    );
    expect(r.retryable).toBe(false);
    expect(r.text).not.toMatch(/P2002|abc|boom/);
  });

  it("describeRunFailure: an unknown failure gets the generic retry sentence with no raw text", () => {
    const r = describeRunFailure("connect ECONNREFUSED 10.0.0.5:5432");
    expect(r.retryable).toBe(true);
    expect(r.text).toMatch(/run now/i);
    expect(r.text).not.toMatch(/ECONN|10\.0/);
  });

  it("describeRunFailure: a suspension keeps naming the restricted lines (tenant data, not provider text)", () => {
    const r = describeRunFailure(
      "Suspended: a line is under a selling restriction (Acme Widget, Acme Gadget). Fix the template and reactivate it; the skipped cycle is not billed.",
    );
    expect(r.text).toMatch(/selling restriction \(Acme Widget, Acme Gadget\)/);
    expect(r.text).not.toMatch(/is not billed/); // our own fixed wording, not the server's
  });

  it("describeRunFailure: a restricted product name containing parentheses is kept whole", () => {
    const r = describeRunFailure(
      "Suspended: a line is under a selling restriction (Acme Soda (12 oz), Acme Gadget). Fix the template and reactivate it; the skipped cycle is not billed.",
    );
    expect(r.text).toContain("(Acme Soda (12 oz), Acme Gadget)");
  });

  it("describeRunFailure keys off the shared RUN_UNFINALIZED_PREFIX constant (REG-B106, no copied string)", () => {
    expect(describeRunFailure(`${RUN_UNFINALIZED_PREFIX} (invoice 1): x`).retryable).toBe(false);
  });

  it("describeReturnReason: every ReturnReason has copy; an unknown value never echoes", () => {
    for (const v of RETURN_REASON_VALUES) expect(describeReturnReason(v)).not.toBe(v);
    expect(describeReturnReason("drop table")).not.toMatch(/drop table/);
  });

  it("describeSaveError maps the HTTP status to a fixed sentence, never the axios message", () => {
    const axiosErr = (status: number) => ({
      message: "Request failed with status code " + status,
      response: { status, data: { message: "raw server text" } },
    });
    for (const s of [400, 403, 409, 500]) {
      const t = describeSaveError(axiosErr(s));
      expect(t).not.toMatch(/Request failed|raw server text|status code/);
      expect(t.length).toBeGreaterThan(10);
    }
    expect(describeSaveError(axiosErr(409))).toMatch(/already/i);
    // users.service.ts answers a duplicate with 400 + "Email/Username already in use" (review)
    const dup = (message: string) => ({ response: { status: 400, data: { message } } });
    expect(describeSaveError(dup("Email already in use"))).toBe("That email is already in use.");
    expect(describeSaveError(dup("Username already in use"))).toBe(
      "That username is already in use.",
    );
    expect(describeSaveError(dup("role must be a valid enum value"))).toBe(
      "Check the details and try again.",
    );
    expect(describeSaveError(new Error("boom"))).not.toMatch(/boom/);
  });

  it("the scan copy constants are closed sentences", () => {
    expect(SCAN_FAILED_COPY).toMatch(/clearer photo/i);
    expect(RECORDS_FAILED_COPY).toMatch(/try again/i);
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

describe("returnReasonOptions (R7b 3.1)", () => {
  it("delivery context keeps the delivery words", () => {
    expect(returnReasonOptions("delivery")).toEqual([
      { value: "DAMAGED", label: "Damaged" },
      { value: "WRONG_ITEM", label: "Wrong Item" },
      { value: "CUSTOMER_REFUSED", label: "Customer Refused" },
      { value: "QUALITY_ISSUE", label: "Quality Issue" },
      { value: "EXCESS_ORDER", label: "Excess / Overdelivery" },
    ]);
  });

  it("counter context says what happened at the register, with the same enum values", () => {
    const counter = returnReasonOptions("counter");
    expect(counter.map((o) => o.value)).toEqual(
      returnReasonOptions("delivery").map((o) => o.value),
    );
    expect(Object.fromEntries(counter.map((o) => [o.value, o.label]))).toEqual({
      DAMAGED: "Damaged",
      WRONG_ITEM: "Wrong item",
      CUSTOMER_REFUSED: "Changed their mind",
      QUALITY_ISSUE: "Faulty",
      EXCESS_ORDER: "Bought too many",
    });
  });
});
