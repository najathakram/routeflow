import { Logger } from "@nestjs/common";
import { isLayoutHtml, renderBrandedEmail } from "./email-layout";
import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/** W-1163 PR-2: a tenant's own mail wears the tenant's look (name, logo, colour), never RouteFlow's. */

const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");

function service(opts: {
  tenantId?: string | null;
  cfg?: {
    businessName?: string | null;
    logoKey?: string | null;
    primaryColor?: string | null;
  } | null;
  apiUrl?: string;
  slug?: string;
}) {
  const tenantId = opts.tenantId === undefined ? "t1" : opts.tenantId;
  const prisma = {
    getTenantId: () => tenantId,
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(opts.cfg ?? null) },
    tenant: { findUnique: jest.fn().mockResolvedValue({ slug: opts.slug ?? "acme" }) },
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const config = {
    get: (k: string) => (k === "API_PUBLIC_URL" ? opts.apiUrl : undefined),
  } as any;
  return new EmailService(
    config,
    prisma,
    { decrypt: (v: string) => v } as any,
    { trySend: jest.fn() } as any,
    { record: jest.fn() } as any,
    {} as any,
  );
}

describe("EmailService.tenantLook", () => {
  it("carries the name, the colour and a logo through the public logo route", async () => {
    const look = await service({
      cfg: { businessName: "Acme Foods", logoKey: "logos/a.png", primaryColor: "#1D4E89" },
      apiUrl: "https://api.test/",
      slug: "acme",
    }).tenantLook();
    expect(look).toEqual({
      kind: "tenant",
      name: "Acme Foods",
      logoUrl: "https://api.test/api/v1/public/tenants/acme/logo",
      color: "#1D4E89",
    });
  });

  it("has no logo when the tenant has none, or when the API's public URL is not configured", async () => {
    const noKey = await service({
      cfg: { businessName: "Acme Foods", logoKey: null },
      apiUrl: "https://api.test",
    }).tenantLook();
    const noUrl = await service({
      cfg: { businessName: "Acme Foods", logoKey: "logos/a.png" },
    }).tenantLook();
    expect(noKey).toMatchObject({ kind: "tenant", logoUrl: null });
    expect(noUrl).toMatchObject({ kind: "tenant", logoUrl: null });
  });

  it("is neutral, never RouteFlow's, with no tenant context or no configured name", async () => {
    expect(await service({ tenantId: null }).tenantLook()).toEqual({ kind: "neutral" });
    expect(await service({ cfg: { businessName: "  " } }).tenantLook()).toEqual({
      kind: "neutral",
    });
    expect(await service({ cfg: null }).tenantLook()).toEqual({ kind: "neutral" });
  });
});

describe("a body fragment with a `layout` spec (EmailService.composeLayout)", () => {
  const layout = {
    heading: "Your statement",
    footerNote: "You are getting this because Acme sent it.",
  };

  it("is dressed in the tenant's look: logo, colour, heading, why, 'Sent with RouteFlow'", async () => {
    const out = await (
      service({
        cfg: { businessName: "Acme Foods", logoKey: "k", primaryColor: "#1D4E89" },
        apiUrl: "https://api.test",
      }) as any
    ).composeLayout({ subject: "s", html: "<p>Hello.</p>", text: "Hello.", layout });
    expect(isLayoutHtml(out.html)).toBe(true);
    expect(out.html).toContain("<p>Hello.</p>");
    expect(out.html).toContain("https://api.test/api/v1/public/tenants/acme/logo");
    expect(out.html).toContain("#1D4E89");
    expect(visible(out.html)).toContain("Your statement");
    expect(visible(out.html)).toContain("Sent with RouteFlow");
    expect(out.html).not.toMatch(/alt="RouteFlow"/);
    expect(out.text).toContain("Your statement");
    expect(out.text).toContain("Hello.");
    expect(out.text).toContain("You are getting this because Acme sent it.");
    expect(out.layout).toBeUndefined();
  });

  it("derives the text part from the fragment when the sender gave none", async () => {
    const out = await (service({ cfg: { businessName: "Acme Foods" } }) as any).composeLayout({
      subject: "s",
      html: '<p>One.</p><p>Two <a href="https://app.test/x">link</a>.</p>',
      layout,
    });
    expect(out.text).toContain("One.");
    expect(out.text).toContain("link (https://app.test/x)");
  });

  it("a tenant with no configured name gets the neutral look: no RouteFlow mark or wordmark", async () => {
    const out = await (service({ cfg: null }) as any).composeLayout({
      subject: "s",
      html: "<p>Hello.</p>",
      layout,
    });
    expect(out.html).not.toMatch(/alt="RouteFlow"|routeflow-mark|Sent by RouteFlow/);
    expect(visible(out.html)).not.toContain("Sent with");
  });

  it("leaves a send without a `layout` spec untouched", async () => {
    const params = { subject: "s", html: "<p>x</p>" };
    expect(await (service({}) as any).composeLayout(params)).toBe(params);
  });

  it("the guard then leaves composed html alone (no error logged)", async () => {
    const err = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const svc = service({ cfg: { businessName: "Acme Foods" } }) as any;
    const composed = await svc.composeLayout({ subject: "s", html: "<p>x</p>", layout });
    const out = await svc.ensureLayout(composed, true);
    expect(out.html).toBe(composed.html);
    expect(err).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe("the invoice email's footer", () => {
  const params = {
    customerName: "Corner Deli",
    invoiceNumber: "INV-1",
    issueDate: "2026-11-06",
    dueDate: "2026-12-06",
    total: 10,
    items: [{ description: "Water", qty: 1, unitPrice: 10, subtotal: 10 }],
  };

  it("names the tenant, and for a tenant with no name says nothing of RouteFlow", () => {
    const svc = service({}) as any;
    const named = svc.buildInvoiceEmail(params, "Acme Foods", {
      kind: "tenant",
      name: "Acme Foods",
    });
    expect(named.text).toContain("This is an automated email from Acme Foods.");
    const unnamed = svc.buildInvoiceEmail(params, "RouteFlow", { kind: "neutral" });
    expect(unnamed.text).toContain("This is an automated email.");
    expect(unnamed.html).not.toMatch(/Sent by RouteFlow|alt="RouteFlow"|automated email from/);
    expect(unnamed.text).not.toContain("automated email from RouteFlow");
  });
});

describe("renderBrandedEmail with a tenant look (the invoice shell)", () => {
  const tenant = {
    kind: "tenant" as const,
    name: "Acme Foods",
    logoUrl: "https://api.test/api/v1/public/tenants/acme/logo",
    color: "#1D4E89",
  };

  it("wears the tenant's header, bar colour and 'Sent with RouteFlow', in both parts", () => {
    const { html, text } = renderBrandedEmail({
      look: tenant,
      heading: "Invoice",
      bodyHtml: "<p>Body</p>",
      bodyText: ["Body"],
      footerNote: "This is an automated email from Acme Foods.",
    });
    expect(html).toContain('alt="Acme Foods"');
    expect(html).toContain("#1D4E89");
    expect(visible(html)).toContain("Sent with RouteFlow");
    expect(html).not.toMatch(/alt="RouteFlow"/);
    expect(text).toContain("Sent with RouteFlow");
  });

  it("without a look it keeps the caller's own header and says nothing about RouteFlow", () => {
    const { html, text } = renderBrandedEmail({
      headerHtml: "<span>Own header</span>",
      heading: "Invoice",
      bodyHtml: "<p>Body</p>",
      bodyText: ["Body"],
      footerNote: "Footer.",
    });
    expect(html).toContain("Own header");
    expect(visible(html)).not.toContain("Sent with");
    expect(text).not.toContain("Sent with");
  });

  it("a hostile colour or logo url never reaches the markup", () => {
    const { html } = renderBrandedEmail({
      look: {
        ...tenant,
        color: "red;background:url(//evil.example)",
        logoUrl: "javascript:alert(1)",
      },
      heading: "Invoice",
      bodyHtml: "",
      bodyText: [],
      footerNote: "f",
    });
    expect(html).not.toContain("evil");
    expect(html).not.toContain("javascript:");
  });
});
