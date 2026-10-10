/**
 * #2716c / SA-558c — consumer before/after pins for the converged staff-override rule. A
 * below-list edit now stores DISCOUNTED (list 6, unit 4); an untouched legacy row stays
 * MANUAL-below-list. Each consumer must treat both correctly.
 */
import * as fs from "fs";
import * as path from "path";
import { isUpsellLine } from "@routeflow/pricing";
import { redactUpsellLines } from "../common/upsell-redaction";
import { EmailService } from "../email/email.service";
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

describe("email invoice body strike (EmailService.buildInvoiceEmail) — behaviour, same rule as the PDF", () => {
  // buildInvoiceEmail reads no `this.*`, so a prototype-only instance is enough (no constructor deps).
  const emailService = Object.create(EmailService.prototype);
  const render = (item: Record<string, unknown>) =>
    (emailService as any).buildInvoiceEmail(
      {
        customerName: "Acme",
        invoiceNumber: "INV-1",
        issueDate: "2026-09-29",
        dueDate: "2026-10-29",
        total: 8,
        items: [{ description: "Widget", qty: 1, subtotal: 8, ...item }],
      },
      "Biz",
    ).html as string;

  it("a below-list edited line (DISCOUNTED, original = list) shows the struck list price", () => {
    const html = render({ unitPrice: 8, originalPrice: 10, priceType: "DISCOUNTED" });
    expect(html).toContain("text-decoration:line-through");
    expect(html).toMatch(/<s [^>]*>\$10\.00<\/s>/);
  });

  it("a MANUAL line above list (upsell) never exposes the lower base", () => {
    const html = render({ unitPrice: 12, originalPrice: 10, priceType: "MANUAL", subtotal: 12 });
    expect(html).not.toContain("line-through");
    expect(html).not.toContain("$10.00");
  });
});
