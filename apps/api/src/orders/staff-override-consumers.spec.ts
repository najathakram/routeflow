/**
 * #2716c / SA-558c — consumer before/after pins for the converged staff-override rule. A
 * below-list edit now stores DISCOUNTED (list 6, unit 4); an untouched legacy row stays
 * MANUAL-below-list. Each consumer must treat both correctly.
 */
import * as fs from "fs";
import * as path from "path";
import { isUpsellLine } from "@routeflow/pricing";
import { redactUpsellLines } from "../common/upsell-redaction";
import { showOriginalPrice } from "../invoices/invoice-pdf-item";

const discounted = { priceType: "DISCOUNTED", unitPrice: 4, originalPrice: 6 };
const upsell = { priceType: "MANUAL", unitPrice: 8, originalPrice: 6 };
const legacyManualBelow = { priceType: "MANUAL", unitPrice: 4, originalPrice: 6 };

describe("staff-override consumers (#2716c)", () => {
  it("isUpsellLine: a below-list edit is not an upsell before (MANUAL) or after (DISCOUNTED)", () => {
    expect(isUpsellLine(discounted)).toBe(false);
    expect(isUpsellLine(legacyManualBelow)).toBe(false);
    expect(isUpsellLine(upsell)).toBe(true);
  });

  it("buyer redaction: DISCOUNTED keeps its struck list price; MANUAL-above-list is still redacted", () => {
    const lines = [{ ...discounted }, { ...upsell }, { ...legacyManualBelow }];
    redactUpsellLines(lines);
    expect(lines[0]).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6 });
    expect(lines[1]).toMatchObject({ priceType: "STANDARD", originalPrice: null });
    expect(lines[2]).toMatchObject({ priceType: "MANUAL", originalPrice: 6 });
  });

  it("invoice PDF / email: DISCOUNTED shows the struck list price; an upsell never does", () => {
    expect(showOriginalPrice(discounted, false)).toBe(true);
    expect(showOriginalPrice(legacyManualBelow, false)).toBe(true);
    expect(showOriginalPrice(upsell, false)).toBe(false);
    expect(showOriginalPrice(discounted, true)).toBe(false);
  });

  it("email lines use the same showOriginalPrice helper (no second strike rule)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../email/email.service.ts"), "utf8");
    expect(src).toMatch(/showOriginalPrice\(it, !!params\.hideOriginalPrice\)/);
  });
});
