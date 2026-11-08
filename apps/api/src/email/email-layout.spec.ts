import { Logger } from "@nestjs/common";
import {
  BRAND_NAVY,
  EMAIL_LAYOUT_MARKER,
  htmlToPlainText,
  isLayoutHtml,
  readableLinkText,
  renderBrandButton,
  renderEmailLayout,
  resolveBarColors,
  tenantHeaderHtml,
  wrapUnbrandedHtml,
} from "./email-layout";
import {
  newLoginMessage,
  passwordResetMessage,
  passwordSetMessage,
  routeflowNotice,
  signInLinkedMessage,
  verifyEmailMessage,
} from "./routeflow-mail";
import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/** What a reader sees: tags and attributes gone. A token that lives in an href is not in it. */
const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ");

const TOKEN_URL = "https://app.test/verify-email?token=eyJhbGciOiJIUzI1NiJ9.AAAA.BBBB";

const layout = (over: Partial<Parameters<typeof renderEmailLayout>[0]> = {}) =>
  renderEmailLayout({
    look: { kind: "routeflow" },
    heading: "Verify your email",
    bodyHtml: "<p>Hello.</p>",
    bodyText: ["Hello."],
    cta: { label: "Verify my email", url: TOKEN_URL },
    footerNote: "You are getting this because this address signed up.",
    ...over,
  });

describe("renderEmailLayout — the one layout (W-1163)", () => {
  it("is marked, 600px, inline-styled, light and dark aware, with alt text", () => {
    const { html } = layout();
    expect(html).toContain(EMAIL_LAYOUT_MARKER);
    expect(isLayoutHtml(html)).toBe(true);
    expect(html).toContain('width="600"');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toMatch(/<img [^>]*alt="RouteFlow"/);
    expect(html).toContain("https://www.routeflow.info/brand/routeflow-mark-192.png");
    expect(html).not.toMatch(/<style|<link|@import|<script/i);
  });

  it("never prints a token URL as visible text, and the fallback link is short and readable", () => {
    const { html } = layout();
    expect(visible(html)).not.toContain("token=");
    expect(visible(html)).not.toContain("eyJ");
    expect(visible(html)).toContain("app.test/verify-email");
    // The fallback link text names the same host as the href it opens.
    const [, href, text] =
      /use this link: <a href="([^"]+)" style="color:#087D76;">([^<]+)<\/a><\/p>/.exec(html)!;
    expect(new URL(href.replace(/&amp;/g, "&")).host).toBe(text.split("/")[0]);
    // It never invites typing the address: that path has no token and would not open the page.
    expect(visible(html)).not.toMatch(/\bopen\b[^.]*in your browser/);
    expect(text).not.toMatch(/[?=&]/);
  });

  it("has exactly one bulletproof button: a table cell that carries the colour, with the link inside", () => {
    const { html } = layout();
    const cells = html.match(
      /<td style="background:#087D76;border-radius:6px;" bgcolor="#087D76">/g,
    );
    expect(cells).toHaveLength(1);
    expect(html).toMatch(
      /bgcolor="#087D76">\s*<a href="https:\/\/app\.test\/verify-email\?token=[^"]+" style="[^"]*">Verify my email<\/a>/,
    );
  });

  it("carries the full link in the plain-text part, with the heading, the body and the reason", () => {
    const { text } = layout();
    expect(text).toContain(`Verify my email: ${TOKEN_URL}`);
    expect(text.startsWith("Verify your email\n\nHello.")).toBe(true);
    expect(text).toContain("You are getting this because this address signed up.");
  });

  it("escapes the heading, the preheader and the footer", () => {
    const { html } = layout({
      heading: "<script>x</script>",
      preheader: '"><img src=x>',
      footerNote: "<b>why</b>",
    });
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain('"><img src=x>');
    expect(html).not.toContain("<b>why</b>");
  });

  it("refuses a javascript: link: the button has no href", () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { html } = layout({ cta: { label: "Go", url: "javascript:alert(1)" } });
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/<span style="[^"]*">Go<\/span>/);
    jest.restoreAllMocks();
  });

  it("a colour that is not #rrggbb never reaches a style attribute (button and tenant name)", () => {
    const hostile = "red;background:url(//evil.example)";
    expect(renderBrandButton("Go", "https://app.test/x", hostile)).not.toContain("evil");
    expect(tenantHeaderHtml("Acme", hostile)).not.toContain("evil");
    expect(renderBrandButton("Go", "https://app.test/x", hostile)).toContain("#087D76");
  });

  it("sets an explicit text colour on the body: a client's dark mode never turns unstyled text white on white", () => {
    expect(layout().html).toMatch(
      /<td style="padding:32px;color:#1D2A3D;[^"]*" bgcolor="#FFFFFF">/,
    );
  });

  it("a RouteFlow-look email has no 'Sent with RouteFlow' line (it IS RouteFlow's)", () => {
    expect(visible(layout().html)).not.toContain("Sent with");
  });
});

describe("tenant look", () => {
  const tenant = (color?: string | null, logoUrl?: string | null) =>
    layout({ look: { kind: "tenant", name: "Acme Foods", color, logoUrl } });

  it("shows the tenant's name, logo and colour, and a small 'Sent with RouteFlow' line", () => {
    const { html, text } = tenant("#7A1F2B", "https://api.test/api/v1/public/tenants/acme/logo");
    expect(html).toContain("background:#7A1F2B;padding:24px 32px;");
    expect(html).toMatch(
      /<img src="https:\/\/api\.test\/api\/v1\/public\/tenants\/acme\/logo"[^>]*alt="Acme Foods"/,
    );
    expect(visible(html)).toContain("Acme Foods");
    expect(visible(html)).toContain("Sent with RouteFlow");
    expect(html).not.toMatch(/alt="RouteFlow"/);
    expect(html).not.toContain("routeflow-mark");
    expect(text).toContain("Sent with RouteFlow");
  });

  it("a dark colour keeps white text and colours the button; a light one gets dark text and a navy button", () => {
    expect(resolveBarColors("#7A1F2B")).toEqual({
      bg: "#7A1F2B",
      fg: "#FFFFFF",
      button: "#7A1F2B",
    });
    expect(resolveBarColors("#F5D76E")).toEqual({
      bg: "#F5D76E",
      fg: BRAND_NAVY,
      button: BRAND_NAVY,
    });
  });

  it.each([
    "red",
    "#abc",
    "#12345g",
    "rgb(0,0,0)",
    '#000000;background:url("x")',
    "",
    null,
    undefined,
  ])("a bad colour (%p) falls back to Route Navy and is never written into the html", (bad) => {
    expect(resolveBarColors(bad as string | null | undefined).bg).toBe(BRAND_NAVY);
    const { html } = tenant(bad as string | null | undefined);
    if (typeof bad === "string" && bad) expect(html).not.toContain(bad);
  });

  it("no logo: the name alone, no broken image", () => {
    const { html } = tenant("#7A1F2B", null);
    expect(html).not.toContain("<img");
    expect(visible(html)).toContain("Acme Foods");
  });

  it("a non-http logo url is dropped", () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    expect(tenant("#7A1F2B", "javascript:alert(1)").html).not.toContain("javascript:");
    jest.restoreAllMocks();
  });

  it("escapes a hostile business name in the text and in the alt", () => {
    const { html } = layout({
      look: { kind: "tenant", name: '"><script>x</script>', logoUrl: "https://a.test/l.png" },
    });
    expect(html).not.toContain("<script>x");
  });
});

describe("neutral look", () => {
  it("claims nobody: no RouteFlow mark, wordmark or 'Sent with' line", () => {
    const { html, text } = layout({ look: { kind: "neutral" } });
    expect(html).toContain(EMAIL_LAYOUT_MARKER);
    expect(html).not.toContain("routeflow-mark");
    expect(html).not.toMatch(/routeflow\.<\/span>/);
    expect(visible(html)).not.toContain("Sent with");
    expect(text).not.toContain("Sent with");
  });
});

describe("helpers", () => {
  it("readableLinkText drops the query and fragment, where a token lives", () => {
    expect(readableLinkText("https://app.test/reset-password?token=abc#frag")).toBe(
      "app.test/reset-password",
    );
    expect(readableLinkText("https://app.test/")).toBe("app.test");
    expect(readableLinkText("not a url")).toBe("this link");
    expect(readableLinkText(`https://app.test/${"a".repeat(80)}`)).toBe("app.test/…");
  });

  it("htmlToPlainText keeps paragraph breaks, decodes entities and writes links out in full", () => {
    const t = htmlToPlainText(
      '<p>Fish &amp; chips</p><p><a href="https://a.test/x?y=1">Open</a></p><ul><li>one</li><li>two</li></ul>',
    );
    expect(t).toBe("Fish & chips\n\nOpen (https://a.test/x?y=1)\n\none\ntwo");
  });

  it("wrapUnbrandedHtml unwraps a full document and keeps the caller's body", () => {
    const html = wrapUnbrandedHtml({
      look: { kind: "neutral" },
      subject: "Hello",
      html: "<!DOCTYPE html><html><body><p>inner body</p></body></html>",
      footerNote: "This is an automated message.",
    });
    expect(isLayoutHtml(html)).toBe(true);
    expect(html.match(/<!DOCTYPE/gi)).toHaveLength(1);
    expect(html).toContain("<p>inner body</p>");
  });
});

describe("RouteFlow's own mail", () => {
  const all = () => [
    verifyEmailMessage({
      verifyUrl: TOKEN_URL,
      webUrl: "https://app.test",
      workspaceId: "acme",
      businessName: "Acme Foods",
    }),
    verifyEmailMessage({
      verifyUrl: TOKEN_URL,
      webUrl: "https://app.test",
      workspaceId: "acme",
      businessName: "Acme Foods",
      resendFor: { username: "jamie" },
    }),
    passwordResetMessage({ resetUrl: "https://app.test/reset-password?token=abcdef0123456789" }),
    passwordSetMessage({ portal: false, ip: "203.0.113.5", time: "Nov 6, 2026" }),
    passwordSetMessage({ portal: true, ip: "203.0.113.5", time: "Nov 6, 2026" }),
    newLoginMessage({ device: "Chrome on Windows", ip: "203.0.113.5", time: "Nov 6, 2026" }),
    signInLinkedMessage({ provider: "Google", address: "jamie@acme.example", portal: false }),
    signInLinkedMessage({ provider: "Apple", address: "jamie@acme.example", portal: true }),
    routeflowNotice({ subject: "s", heading: "h", lines: ["a", ["b ", { b: "c" }]], why: "w" }),
  ];

  it.each(all().map((m, i) => [i, m.subject, m] as const))(
    "#%i %s: marked, has a text part, says why",
    (_i, _s, m) => {
      expect(isLayoutHtml(m.html)).toBe(true);
      expect(m.text.length).toBeGreaterThan(5);
      expect(m.html).toMatch(/alt="RouteFlow"/);
      expect(visible(m.html)).not.toMatch(/token=|eyJ/);
    },
  );

  it("verify: one button, the trial sentence, the Workspace ID, a true reason", () => {
    const m = all()[0];
    expect(m.html).toContain(">Verify my email</a>");
    expect(visible(m.html)).toContain(
      "Verify your email to open your 14-day free trial for Acme Foods.",
    );
    expect(visible(m.html)).toContain("enter your Workspace ID: acme");
    expect(m.text).toContain(`Verify my email: ${TOKEN_URL}`);
    expect(visible(m.html)).toContain("you can ignore this email");
  });

  it("reset: says 15 minutes (the token's own expiry) and that nothing changes if ignored", () => {
    const m = all()[2];
    expect(visible(m.html)).toContain("The link works for 15 minutes.");
    expect(visible(m.html)).toContain("your password will not change");
    expect(m.html).not.toMatch(/unsubscribe/i);
  });

  it("makes no promise the code does not keep: no unsubscribe, no 'reply to this email'", () => {
    for (const m of all()) {
      expect(visible(m.html)).not.toMatch(/unsubscribe|reply to this email|never share/i);
    }
  });
});

describe("the layout guard in EmailService (never RouteFlow's name on a tenant's mail)", () => {
  function service(tenantId: string | null, businessName: string | null = "Acme Foods") {
    const prisma = {
      getTenantId: () => tenantId,
      tenantConfig: { findFirst: jest.fn().mockResolvedValue({ businessName }) },
      forTenant: () => ({
        systemConfig: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      }),
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
    return new EmailService(
      { get: () => undefined } as any,
      prisma,
      { decrypt: (v: string) => v } as any,
      { trySend: jest.fn() } as any,
      { record: jest.fn() } as any,
      {} as any,
    );
  }
  const bare = { subject: "Hi", html: "<p>bare body</p>" };

  it("leaves marked html alone", async () => {
    const mail = layout();
    const out = await (service("t1") as any).ensureLayout({ subject: "s", html: mail.html }, true);
    expect(out.html).toBe(mail.html);
  });

  it("wraps bare html in the tenant's look when the send belongs to a tenant, and logs an error", async () => {
    const err = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const out = await (service("t1") as any).ensureLayout(bare, true);
    expect(isLayoutHtml(out.html)).toBe(true);
    expect(out.html).toContain("<p>bare body</p>");
    expect(visible(out.html)).toContain("Sent with RouteFlow");
    expect(out.html).not.toMatch(/alt="RouteFlow"/);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("outside the shared layout"));
    jest.restoreAllMocks();
  });

  it("wraps bare html neutrally when there is no tenant (and for platform sends, which never read one)", async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    for (const [tenantId, scoped] of [
      [null, true],
      ["t1", false],
    ] as const) {
      const out = await (service(tenantId) as any).ensureLayout(bare, scoped);
      expect(isLayoutHtml(out.html)).toBe(true);
      expect(out.html).not.toContain("routeflow-mark");
      expect(out.html).not.toMatch(/routeflow\.<\/span>/);
      expect(visible(out.html)).not.toContain("Sent with");
    }
    jest.restoreAllMocks();
  });

  it("a tenant with no configured name gets the neutral look, never RouteFlow's name", async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const out = await (service("t1", null) as any).ensureLayout(bare, true);
    expect(isLayoutHtml(out.html)).toBe(true);
    expect(out.html).not.toMatch(/alt="RouteFlow"|Sent by RouteFlow|routeflow-mark/);
    expect(visible(out.html)).not.toContain("Sent with");
    jest.restoreAllMocks();
  });

  it("a full document is logged but sent as built: re-wrapping would nest two headers", async () => {
    const err = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const doc = {
      subject: "Hi",
      html: "<!DOCTYPE html><html><body><p>own shell</p></body></html>",
    };
    const out = await (service("t1") as any).ensureLayout(doc, true);
    expect(out.html).toBe(doc.html);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("outside the shared layout"));
    jest.restoreAllMocks();
  });
});
