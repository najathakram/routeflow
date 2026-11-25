/**
 * SA-1304 C2 (W-1433; copy ruling 7172194631 over 7170572581; placement per pc-sa-3 ruling 7175523856): the one home for
 * the yearly words, in @routeflow/pricing (a built dist the api, web and mobile can all value-import).
 *
 * C-T13: every builder returns its exact sentence for placeholder values, and the module computes nothing
 * (no arithmetic operator, no Math., no toFixed, no import at all, so no price helper). The dark pin is in
 * term-copy.dark.pin.spec.ts.
 */
import * as fs from "fs";
import * as path from "path";
import {
  TERM_POLICY,
  TERM_TOGGLE_LABELS,
  yearPriceLabel,
  yearConfirmLine,
  yearSavingLine,
  twoMonthsFreeLine,
  switchToYearlyLabel,
  switchToMonthlyLabel,
  switchStartsLine,
  cancelYearlyLine,
  refundWindowLine,
  addonYearlyAddLine,
  addonYearlyRemoveLine,
  renewalReminderLine,
  yearlyReceiptLine,
  TERM_TRIAL_LINE,
  TERM_SITE_LEDE,
  TERM_ADDON_BLOCKED_LINE,
  refundDoneMessage,
  refundOutsideWindowMessage,
} from "./term-copy";

const MODULE_PATH = path.join(__dirname, "term-copy.ts");

describe("term-copy builders (C-T13)", () => {
  it("S1 toggle labels", () => {
    expect(TERM_TOGGLE_LABELS).toEqual({ monthly: "Monthly", yearly: "Yearly" });
  });

  it("S2 year price", () => {
    expect(yearPriceLabel("$990.00")).toBe("$990.00 a year");
  });

  it("S3 confirm line", () => {
    expect(yearConfirmLine("$990.00", "Dec 1, 2027")).toBe(
      "$990.00 a year, billed today. Renews on Dec 1, 2027.",
    );
  });

  it("S4 saving line", () => {
    expect(yearSavingLine("$198.00")).toBe(
      "That's $198.00 less than 12 months of monthly billing.",
    );
  });

  it("S4b two months free", () => {
    expect(twoMonthsFreeLine("$198.00")).toBe(
      "2 months free: $198.00 less than 12 months of monthly billing.",
    );
  });

  it("S5 own-plan switch labels and sub-line", () => {
    expect(switchToYearlyLabel()).toBe("Switch to yearly billing");
    expect(switchToMonthlyLabel()).toBe("Switch to monthly billing");
    expect(switchStartsLine("Dec 1, 2027")).toBe("Starts on Dec 1, 2027.");
  });

  it("S6 cancel line", () => {
    expect(cancelYearlyLine("Dec 1, 2027")).toBe(
      "If you cancel, your plan stays active until Dec 1, 2027. Nothing is refunded automatically.",
    );
  });

  it("S7 refund window line", () => {
    expect(refundWindowLine()).toBe(
      "Changed your mind? Contact us within 14 days of paying for a year and we'll refund the full yearly payment. Your plan ends when we do.",
    );
  });

  it("S8 add-on added on a yearly plan", () => {
    expect(
      addonYearlyAddLine({
        addonName: "Scanning",
        addonCharge: "$40.00",
        renewalDate: "Dec 1, 2027",
      }),
    ).toBe(
      "Adding Scanning now costs $40.00 today for the rest of your year. It then renews with your plan on Dec 1, 2027.",
    );
  });

  it("S9 add-on removed on a yearly plan", () => {
    expect(addonYearlyRemoveLine({ addonName: "Scanning", renewalDate: "Dec 1, 2027" })).toBe(
      "You keep Scanning until Dec 1, 2027. It isn't refunded.",
    );
  });

  it("S10 reminder email line", () => {
    expect(renewalReminderLine("Dec 1, 2027", "$990.00")).toBe(
      "Your plan renews on Dec 1, 2027 for $990.00.",
    );
  });

  it("S11 receipt email line", () => {
    expect(yearlyReceiptLine("$990.00", "Dec 1, 2027")).toBe(
      "You paid $990.00 for a year. Your plan renews on Dec 1, 2027.",
    );
  });

  it("S12 trial line", () => {
    expect(TERM_TRIAL_LINE).toBe(
      "When your 14 days free end, choose monthly or yearly. You're not charged until you choose.",
    );
  });

  it("S13 site lede", () => {
    expect(TERM_SITE_LEDE).toBe("Pay yearly and get 2 months free.");
  });

  it("S14 add-on blocked line", () => {
    expect(TERM_ADDON_BLOCKED_LINE).toBe(
      "Add-ons can't be added to a yearly plan online yet. Please contact support.",
    );
  });

  it("R-1 refund done message", () => {
    expect(refundDoneMessage("$990.00")).toBe(
      "Hello, we've refunded your yearly payment of $990.00 in full, as you asked, and your subscription has ended. You won't be charged again. Your bank decides when the refund shows on your statement.",
    );
  });

  it("R-1 outside 14 days message", () => {
    expect(refundOutsideWindowMessage("Dec 1, 2027")).toBe(
      "Your yearly payment was made more than 14 days ago, so it can't be refunded. Your plan stays active until Dec 1, 2027, and you can cancel so it doesn't renew.",
    );
  });

  it("TERM_POLICY holds words only", () => {
    expect(TERM_POLICY).toEqual({ refundWindow: "14 days", trialLength: "14 days" });
    for (const v of Object.values(TERM_POLICY)) expect(typeof v).toBe("string");
  });

  it("never reprints the plan key or the internal word", () => {
    const all = [
      TERM_TRIAL_LINE,
      TERM_SITE_LEDE,
      TERM_ADDON_BLOCKED_LINE,
      refundWindowLine(),
      yearConfirmLine("x", "y"),
    ].join(" ");
    expect(all).not.toMatch(/annual|ANNUAL/);
  });
});

/** Strip block and line comments so prose in the doc comment cannot trip the operator scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("term-copy computes nothing (C-T13)", () => {
  const code = stripComments(fs.readFileSync(MODULE_PATH, "utf8"));

  it("has code to scan", () => {
    expect(code.length).toBeGreaterThan(200);
  });

  it.each([
    ["multiplication", /\*/],
    ["division", /\//],
    ["Math.", /Math\./],
    ["toFixed", /toFixed/],
    ["an import (no price helper)", /^\s*import\s/m],
    ["a require", /\brequire\(/],
  ])("contains no %s", (_label, pattern) => {
    expect(code).not.toMatch(pattern);
  });

  it("the scan itself sees an operator (probe)", () => {
    expect(stripComments("const a = b * 2;")).toMatch(/\*/);
    expect(stripComments("/** a * b */ const a = 1;")).not.toMatch(/\*/);
  });
});
