import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/**
 * B807 (REG-B807) — tenant- and buyer-entered text must never reach an HTML email body
 * unescaped. email.service.ts built invoice, merge and SMTP-test emails by interpolating
 * descriptions, customer names, invoice numbers, terms, dates and emails straight into HTML.
 */

// ─── Structural guard: every ${…} in an HTML template literal is provably safe ─────────────────

/**
 * A raw interpolation that is safe for a stated reason. The list may only SHRINK: a new raw
 * interpolation fails, and so does an entry that no longer appears in the file.
 */
const ALLOWED: Record<string, string> = {
  // Numbers: they render as digits and can carry no markup.
  freeUnits: "number",
  "params.expiryHours": "number",
  "it.currentStock": "number",
  "it.reorderPoint": "number",
  overflow: "number",
  "params.items.length": "number",
  // HTML fragments built ONLY from HTML template literals in this file, which this scan checks
  // too, so every value inside them is already held to the same rule.
  "params.headerHtml": "brandHeaderHtml(): escapes the business name",
  "params.bodyHtml": "renderBrandedEmail is module-private; every body is a scanned template",
  amountPaidRow: "scanned fragment",
  creditAppliedRow: "scanned fragment",
  advanceAppliedRow: "scanned fragment",
  reminderBanner: "scanned fragment",
  depositBanner: "scanned fragment",
  itemRows: "scanned fragment",
  totalsFooter: "scanned fragment",
  pdfButton: "scanned fragment",
  signInLine: "scanned fragment (both callers pass HTML templates)",
  rows: "scanned fragment",
};

const SRC = readFileSync(join(__dirname, "email.service.ts"), "utf8");
const HTML_TAG = /<[a-zA-Z!/]/;

/** Safe without an allow-list entry: escaped, money-formatted, a literal, or a brand constant. */
function inherentlySafe(e: ts.Expression, src: ts.SourceFile): boolean {
  if (ts.isParenthesizedExpression(e)) return inherentlySafe(e.expression, src);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  // A nested template is itself scanned as HTML (see rawInterpolations), so it is safe HERE.
  if (ts.isTemplateExpression(e)) return true;
  if (ts.isIdentifier(e) && /^BRAND_[A-Z_]+$/.test(e.text)) return true;
  if (ts.isCallExpression(e)) {
    const callee = e.expression.getText(src);
    // escapeHtml escapes; fmt is Intl currency formatting; renderBrandButton escapes its
    // label and url inside (a scanned template).
    return ["escapeHtml", "fmt", "renderBrandButton"].includes(callee);
  }
  // The condition never renders; only the branches do.
  if (ts.isConditionalExpression(e)) {
    return inherentlySafe(e.whenTrue, src) && inherentlySafe(e.whenFalse, src);
  }
  return false;
}

/** Every `${…}` inside an HTML template (one with a tag, or nested in one) that is not safe. */
export function rawInterpolations(code: string): string[] {
  const src = ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: ts.Node, inHtml: boolean) => {
    let html = inHtml;
    if (ts.isTemplateExpression(n)) {
      html = inHtml || HTML_TAG.test(n.getText(src));
      if (html) {
        for (const span of n.templateSpans) {
          if (!inherentlySafe(span.expression, src)) {
            hits.push(span.expression.getText(src).replace(/\s+/g, " "));
          }
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, html));
  };
  visit(src, false);
  return hits;
}

describe("B807 — no unescaped interpolation in email.service.ts HTML bodies (REG-B807)", () => {
  it("the scanner flags a raw value, including one nested in a tagless template (never vacuous)", () => {
    expect(rawInterpolations("const a = `<p>${name}</p>`;")).toEqual(["name"]);
    expect(rawInterpolations("const a = `<p>${x ? ` by ${d}` : ''}</p>`;")).toEqual(["d"]);
    expect(
      rawInterpolations("const a = `<p>${escapeHtml(name)} ${fmt(n)} ${BRAND_NAVY}</p>`;"),
    ).toEqual([]);
    expect(rawInterpolations("const a = `plain ${name}`;")).toEqual([]);
  });

  it("every raw interpolation in an HTML body is on the reasoned allow-list", () => {
    expect(rawInterpolations(SRC).filter((t) => !(t in ALLOWED))).toEqual([]);
  });

  it("every allow-list entry still appears raw in an HTML body (the list may only shrink)", () => {
    const raw = new Set(rawInterpolations(SRC));
    expect(Object.keys(ALLOWED).filter((t) => !raw.has(t))).toEqual([]);
  });
});

// ─── Behavioral pins: a <script> payload in each field arrives escaped ─────────────────────────

const XSS = `<script>alert("x")</script>`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

function makeService(): EmailService {
  const config = { get: () => undefined } as any;
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const mailboxSend = {
    trySend: jest.fn().mockResolvedValue({ delivered: false, transport: "mailbox" }),
  } as any;
  return new EmailService(config, prisma, { decrypt: (v: string) => v } as any, mailboxSend);
}

/** The HTML of every send() the service makes, with delivery stubbed out. */
function captureHtml(svc: EmailService): string[] {
  const htmls: string[] = [];
  jest.spyOn(svc, "send").mockImplementation(async (p: any) => {
    htmls.push(p.html);
    return { delivered: true, transport: "smtp" } as any;
  });
  return htmls;
}

const expectEscaped = (html: string) => {
  expect(html).not.toContain("<script>");
  expect(html).toContain(ESCAPED);
};

describe("B807 — each tenant/buyer field is HTML-escaped in its email (REG-B807)", () => {
  const invoice = (over: Record<string, unknown>) => ({
    customerName: "Acme Market",
    invoiceNumber: "INV-1001",
    issueDate: "Sep 1, 2026",
    dueDate: "Sep 30, 2026",
    paymentTermsLabel: "Net 30",
    total: 12,
    items: [{ description: "Sample Cola 12pk", qty: 1, unitPrice: 12, subtotal: 12 }],
    pdfUrl: "https://files.example.com/inv.pdf",
    depositAmount: 5,
    depositDueDate: "Sep 10, 2026",
    creditApplied: 2,
    creditNoteNumbers: ["CN-1"],
    balanceDue: 10,
    ...over,
  });
  const buildInvoiceHtml = (over: Record<string, unknown>) =>
    (makeService() as any).buildInvoiceEmail(invoice(over), "Acme Supply").html as string;

  it.each([
    ["line description", { items: [{ description: XSS, qty: 1, unitPrice: 12, subtotal: 12 }] }],
    ["customerName", { customerName: XSS }],
    ["invoiceNumber", { invoiceNumber: XSS }],
    ["paymentTermsLabel", { paymentTermsLabel: XSS }],
    ["issueDate", { issueDate: XSS }],
    ["dueDate", { dueDate: XSS }],
    ["depositDueDate", { depositDueDate: XSS }],
    ["creditNoteNumbers", { creditNoteNumbers: [XSS] }],
  ])("invoice email: %s", (_field, over) => {
    expectEscaped(buildInvoiceHtml(over));
  });

  it('invoice email: pdfUrl cannot break out of its href (a `"` is escaped)', () => {
    const html = buildInvoiceHtml({ pdfUrl: `https://x.example/a"><script>alert("x")</script>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://x.example/a&quot;&gt;&lt;script&gt;');
  });

  it("merge verification email: primaryEmail and to", async () => {
    const svc = makeService();
    const htmls = captureHtml(svc);
    await svc.sendMergeVerificationEmail({
      to: XSS,
      primaryEmail: XSS,
      verifyUrl: "https://app.example.com/v?t=1&u=2",
    });
    expectEscaped(htmls[0]);
    expect(htmls[0].split(ESCAPED)).toHaveLength(3); // both fields
    expect(htmls[0]).toContain('href="https://app.example.com/v?t=1&amp;u=2"');
  });

  it("merge complete emails: primaryEmail, secondaryEmail and the buyer's own name", async () => {
    const svc = makeService();
    const htmls = captureHtml(svc);
    await svc.sendMergeCompleteEmail({ primaryEmail: XSS, secondaryEmail: XSS, primaryName: XSS });
    expect(htmls).toHaveLength(2);
    for (const html of htmls) expectEscaped(html);
  });

  it("SMTP test email: the tenant business name", async () => {
    const svc = makeService();
    const htmls = captureHtml(svc);
    jest.spyOn(svc as any, "getTenantBusinessName").mockResolvedValue(XSS);
    await svc.sendTestEmail("owner@example.com");
    expectEscaped(htmls[0]);
  });
});
