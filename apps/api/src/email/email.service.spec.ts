import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
import * as nodemailer from "nodemailer";

/**
 * R5 — the email layer must be HONEST: `send()` returns `{delivered:false}` (never a
 * silent mock "success") when nothing is configured or a send fails, and it reads the
 * SMTP config from the same SystemConfig `email.*` store the Settings → Email tab
 * writes (the wiring fix). These tests exercise the no-network paths (unconfigured /
 * config-read); real SMTP/Resend delivery is covered by the invoice send-honesty specs.
 */
function makeService(
  opts: {
    resendKey?: string;
    emailFrom?: string;
    systemConfigRows?: any[];
    sendingDomainRow?: any;
    tenantConfig?: any;
  } = {},
): EmailService {
  const config = {
    get: (k: string) =>
      k === "RESEND_API_KEY" ? opts.resendKey : k === "EMAIL_FROM" ? opts.emailFrom : undefined,
  } as any;
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue(opts.systemConfigRows ?? []),
        // email.sendingDomain (verified own-domain from-address), Phase 2.
        findFirst: jest.fn().mockResolvedValue(opts.sendingDomainRow ?? null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(opts.tenantConfig ?? null) },
  } as any;
  const encryption = { decrypt: (v: string) => v } as any;
  return new EmailService(config, prisma, encryption);
}

describe("EmailService — honest send (R5)", () => {
  it("send() returns {delivered:false, transport:'none'} when nothing is configured", async () => {
    const svc = makeService();
    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });
    expect(res).toMatchObject({ delivered: false, transport: "none" });
  });

  it("isEmailConfigured() is false with no Resend key and no SMTP config", async () => {
    expect(await makeService().isEmailConfigured()).toBe(false);
  });

  it("isEmailConfigured() is true when the platform Resend key is set", async () => {
    expect(await makeService({ resendKey: "re_test_key" }).isEmailConfigured()).toBe(true);
  });

  it("reads SMTP from the SystemConfig email.* store (Settings → Email wiring fix)", async () => {
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "plaintext-legacy-pw" }, // not enc format → passthrough
        { key: "email.smtpPort", value: "587" },
      ],
    });
    expect(await svc.isEmailConfigured()).toBe(true);
  });

  it("tenant-SMTP send transport is created with fail-fast timeouts (invoice-send hang fix)", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        { key: "email.smtpPassword", value: "pw" },
        { key: "email.smtpPort", value: "587" },
      ],
    });
    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });
    expect(res).toMatchObject({ delivered: true, transport: "smtp" });
    // Without these, nodemailer waits 2 minutes on an unreachable SMTP host and
    // every invoice send/email request hangs before the Resend fallback.
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        dnsTimeout: 10_000,
      }),
    );
  });

  it("ignores a PARTIAL SystemConfig email.* config (no password) and reports unconfigured", async () => {
    const svc = makeService({
      systemConfigRows: [
        { key: "email.smtpHost", value: "smtp.example.com" },
        { key: "email.smtpUser", value: "user@example.com" },
        // no smtpPassword → not usable
      ],
    });
    expect(await svc.isEmailConfigured()).toBe(false);
  });
});

/**
 * WP4 — fail-securely on STARTTLS-less 587: a 587 server that won't offer STARTTLS is
 * accepting the tenant's password in cleartext, so `requireTLS: port===587 && !secure`
 * is set on both transports (mirrors the pre-save verify transport tested separately in
 * `email-smtp-verify.spec.ts`).
 */
describe("EmailService — requireTLS (fail-secure on 587 without SSL)", () => {
  const smtpRows = (port: string, secure: string) => [
    { key: "email.smtpHost", value: "smtp.example.com" },
    { key: "email.smtpUser", value: "user@example.com" },
    { key: "email.smtpPassword", value: "pw" },
    { key: "email.smtpPort", value: port },
    { key: "email.smtpSecure", value: secure },
  ];

  it("sets requireTLS on the SEND transport for 587 with secure off", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows("587", "false") });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it("does NOT set requireTLS on the SEND transport for 465 with secure on", async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "m1" });
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows("465", "true") });

    await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ port: 465, secure: true, requireTLS: false }),
    );
  });
});

/**
 * WP4 — `smtpFallbackReason`: mapSmtpError(...) is captured at the SMTP catch and must
 * ride along on EVERY branch that follows it (Resend rescue, both-fail, no-Resend) — the
 * Resend-rescue case is exactly the one where, before this, nobody learned their own
 * tenant SMTP was broken because `delivered:true` looked like nothing was wrong.
 */
describe("EmailService — smtpFallbackReason (mapped SMTP diagnostic on every branch)", () => {
  const smtpRows = () => [
    { key: "email.smtpHost", value: "smtp.office365.com" },
    { key: "email.smtpUser", value: "user@example.com" },
    { key: "email.smtpPassword", value: "pw" },
    { key: "email.smtpPort", value: "587" },
    { key: "email.smtpSecure", value: "false" },
  ];
  // The M365 disabled-Authenticated-SMTP fixture (5.7.139) — the exact failure the
  // BYO-SMTP-first direction is meant to catch and explain.
  const m365AuthError = () =>
    Object.assign(
      new Error(
        "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
      ),
      { code: "EAUTH", responseCode: 535 },
    );

  it("SMTP fails + Resend rescues ⇒ delivered:true WITH the mapped smtpFallbackReason", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ resendKey: "re_test", systemConfigRows: smtpRows() });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: { id: "eml_1" }, error: null });

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "resend" });
    expect(res.smtpFallbackReason).toMatch(/Authenticated SMTP/);
    // The From identity silently changed too (tenant mailbox → platform address) —
    // that must ride along so the operator-facing toast can disclose it, not bury it.
    expect(res.fromAddress).toBe("invoices@send.routeflow.info");
  });

  it("both SMTP and Resend fail ⇒ delivered:false, but the mapped smtpFallbackReason is still present", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ resendKey: "re_test", systemConfigRows: smtpRows() });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: "domain not verified" } });

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({
      delivered: false,
      transport: "resend",
      error: "domain not verified",
    });
    expect(res.smtpFallbackReason).toMatch(/Authenticated SMTP/);
  });

  it("SMTP fails with no Resend configured ⇒ delivered:false, transport:'smtp', mapped smtpFallbackReason", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows() }); // no resendKey → no rescue

    const res = await svc.send({ to: "a@b.com", subject: "x", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: false, transport: "smtp" });
    expect(res.smtpFallbackReason).toMatch(/Authenticated SMTP/);
  });
});

/**
 * WP4 — `sendTestEmail` must never fall back to the generic message when a mapped
 * reason exists: a mapped failure is more actionable, and a Resend-rescued delivery
 * must say BOTH "it arrived" and "your own SMTP is broken", not just the former.
 */
describe("EmailService.sendTestEmail — mapped reason over generic text", () => {
  const smtpRows = () => [
    { key: "email.smtpHost", value: "smtp.office365.com" },
    { key: "email.smtpUser", value: "user@example.com" },
    { key: "email.smtpPassword", value: "pw" },
    { key: "email.smtpPort", value: "587" },
    { key: "email.smtpSecure", value: "false" },
  ];
  const m365AuthError = () =>
    Object.assign(
      new Error(
        "535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.",
      ),
      { code: "EAUTH", responseCode: 535 },
    );

  it("SMTP fails + no Resend ⇒ success:false with the MAPPED message, not the generic one", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ systemConfigRows: smtpRows() });

    const res = await svc.sendTestEmail("a@b.com");

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Authenticated SMTP/);
    expect(res.message).not.toMatch(/Failed to send test email/);
  });

  it("SMTP fails + Resend delivers ⇒ success:true with the mapped SMTP reason APPENDED", async () => {
    const sendMail = jest.fn().mockRejectedValue(m365AuthError());
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });
    const svc = makeService({ resendKey: "re_test", systemConfigRows: smtpRows() });
    (svc as any).resend.emails.send = jest
      .fn()
      .mockResolvedValue({ data: { id: "eml_1" }, error: null });

    const res = await svc.sendTestEmail("a@b.com");

    // Honest about delivery AND about the underlying tenant-SMTP problem.
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/delivered/i);
    expect(res.message).toMatch(/Authenticated SMTP/);
  });

  it("nothing configured at all ⇒ keeps the generic 'not set up' guidance", async () => {
    const svc = makeService(); // no resend key, no SMTP config
    const res = await svc.sendTestEmail("a@b.com");
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/isn't set up yet/i);
  });
});

describe("EmailService — transactional From identity + reply-to (Phase 1)", () => {
  it("Resend sends from '<Business name> <platform address>' with the tenant Reply-To", async () => {
    const svc = makeService({
      resendKey: "re_test",
      tenantConfig: { businessName: "Acme Co", customerEmail: "hello@acme.com" },
    });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "eml_1" }, error: null });
    (svc as any).resend.emails.send = sendSpy;

    const res = await svc.send({ to: "buyer@x.com", subject: "Hi", html: "<p>x</p>" });

    expect(res).toMatchObject({ delivered: true, transport: "resend" });
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Acme Co <invoices@send.routeflow.info>",
        replyTo: "hello@acme.com",
        to: "buyer@x.com",
      }),
    );
  });

  it("uses a VERIFIED own-domain from-address when the tenant has set one up", async () => {
    const svc = makeService({
      resendKey: "re_test",
      tenantConfig: { businessName: "Acme Co", customerEmail: "hello@acme.com" },
      sendingDomainRow: {
        value: JSON.stringify({ status: "verified", fromAddress: "invoices@acme.com" }),
      },
    });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "eml_2" }, error: null });
    (svc as any).resend.emails.send = sendSpy;

    await svc.send({ to: "buyer@x.com", subject: "Hi", html: "<p>x</p>" });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Acme Co <invoices@acme.com>" }),
    );
  });

  it("does NOT use an own-domain address that isn't verified yet", async () => {
    const svc = makeService({
      resendKey: "re_test",
      tenantConfig: { businessName: "Acme Co" },
      sendingDomainRow: {
        value: JSON.stringify({ status: "pending", fromAddress: "invoices@acme.com" }),
      },
    });
    const sendSpy = jest.fn().mockResolvedValue({ data: { id: "eml_3" }, error: null });
    (svc as any).resend.emails.send = sendSpy;

    await svc.send({ to: "buyer@x.com", subject: "Hi", html: "<p>x</p>" });

    // Pending → falls back to the platform verified address.
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Acme Co <invoices@send.routeflow.info>" }),
    );
  });
});

describe("EmailService — sending-domain management (Phase 2)", () => {
  const verified = (fromAddress: string | null = null) => ({
    value: JSON.stringify({
      domain: "mail.acme.com",
      resendId: "d1",
      status: "verified",
      records: [],
      fromAddress,
    }),
  });

  it("addSendingDomain refuses when platform email (Resend) isn't configured", async () => {
    await expect(makeService().addSendingDomain("mail.acme.com")).rejects.toThrow(
      /platform email/i,
    );
  });

  it("addSendingDomain rejects an invalid domain", async () => {
    await expect(
      makeService({ resendKey: "re_test" }).addSendingDomain("not a domain"),
    ).rejects.toThrow(/valid domain/i);
  });

  it("getSendingDomainStatus reflects the stored verified config", async () => {
    const svc = makeService({
      resendKey: "re_test",
      sendingDomainRow: verified("invoices@mail.acme.com"),
    });
    expect(await svc.getSendingDomainStatus()).toMatchObject({
      platformConfigured: true,
      domain: "mail.acme.com",
      status: "verified",
      fromAddress: "invoices@mail.acme.com",
    });
  });

  it("setSendingFromAddress rejects an address not on the verified domain", async () => {
    const svc = makeService({ resendKey: "re_test", sendingDomainRow: verified() });
    await expect(svc.setSendingFromAddress("invoices@wrong.com")).rejects.toThrow(
      /must be on mail\.acme\.com/i,
    );
  });

  it("setSendingFromAddress requires the domain to be verified first", async () => {
    const svc = makeService({
      resendKey: "re_test",
      sendingDomainRow: {
        value: JSON.stringify({ domain: "mail.acme.com", resendId: "d1", status: "pending" }),
      },
    });
    await expect(svc.setSendingFromAddress("invoices@mail.acme.com")).rejects.toThrow(/verify/i);
  });
});

/**
 * T-B102 / R8 / REG-B102 — send/reminder emails must carry the CONFIRMED-basis
 * `totalPaid`/`balanceDue` (not just the never-changes `total`) and render them in
 * the tfoot the same way the PDF's totals box shows Amount Paid / Balance Due. A
 * reminder must demand the outstanding BALANCE, never the stale total — dunning a
 * customer for the full $500 after they've already paid $300 is exactly the
 * "payment status lies" bug this campaign exists to kill.
 *
 * `sendInvoice`'s params type doesn't declare `totalPaid`/`balanceDue` yet, so the
 * calls below are cast `as any` — the assertions on the RENDERED html (not a TS
 * compile error) are what must go red.
 */
describe("EmailService.sendInvoice — payment truth (T-B102, R8, REG-B102)", () => {
  const baseParams = {
    to: "buyer@example.com",
    customerName: "Acme Buyer",
    invoiceNumber: "INV-2001",
    invoiceId: "inv-2001",
    issueDate: "Jan 1, 2026",
    dueDate: "Jan 31, 2026",
    total: 500,
    totalPaid: 300,
    balanceDue: 200,
    items: [{ description: "Widget", qty: 10, unitPrice: 50, subtotal: 500 }],
  };

  function tfootOf(html: string): string {
    return (html.match(/<tfoot>[\s\S]*?<\/tfoot>/) ?? [""])[0];
  }

  it("REG-B102: a non-reminder send's tfoot shows Amount Paid $300.00 AND Balance Due $200.00 on a $500 invoice with $300 confirmed", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({ ...baseParams, isReminder: false } as any);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).toContain("Amount Paid");
    expect(tfoot).toContain("$300.00");
    expect(tfoot).toContain("Balance Due");
    expect(tfoot).toContain("$200.00");
  });

  it("REG-B102: sendReminder (isReminder:true) demands the $200 balance in its tfoot, never the stale $500 total (mutation: total-as-balance)", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({ ...baseParams, isReminder: true } as any);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).toContain("$200.00");
    // Scoped to the DEMANDED-amount row, not the whole tfoot: R8 wants this footer
    // to mirror the PDF's totals box, and a correct one may legitimately also carry
    // a "Total $500.00" line. A bare `expect(tfoot).not.toContain("$500.00")` would
    // fail that correct build for the wrong reason. What must never happen is the
    // Balance Due row itself demanding the stale total.
    const balanceRow = (tfoot.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Balance Due[\s\S]*?<\/tr>/i) ?? [
      "",
    ])[0];
    expect(balanceRow).toContain("$200.00");
    expect(balanceRow).not.toContain("$500.00");
  });
});

/**
 * B421 — a CREDIT_NOTE/ADVANCE application must never render as "Amount
 * Paid" in an email sent to the customer. This is the client's exact
 * original complaint ("Paid $638.00" although they never paid anything),
 * reaching an email their own customer reads.
 */
describe("EmailService.sendInvoice — credit/advance never render as Amount Paid (REG-B421)", () => {
  const baseParams = {
    to: "buyer@example.com",
    customerName: "Acme Buyer",
    invoiceNumber: "INV-3001",
    invoiceId: "inv-3001",
    issueDate: "Jan 1, 2026",
    dueDate: "Jan 31, 2026",
    total: 870,
    items: [{ description: "Widget", qty: 1, unitPrice: 870, subtotal: 870 }],
  };

  function tfootOf(html: string): string {
    return (html.match(/<tfoot>[\s\S]*?<\/tfoot>/) ?? [""])[0];
  }

  it("REG-B421: a credit-only invoice's tfoot never contains a non-zero Amount Paid row, but does show Credit issued", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 0,
      creditApplied: 638,
      advanceApplied: 0,
      creditNoteNumbers: ["CN-1042"],
      balanceDue: 232,
      isReminder: false,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    // The exact pre-fix bug: "Amount Paid" next to the credit's own figure.
    // $638.00 legitimately appears in the tfoot — under "Credit issued", not
    // "Amount Paid" — so the real assertion is that no "Amount Paid" ROW
    // exists at all, never that the figure itself is absent.
    expect(tfoot).not.toContain("Amount Paid");
    expect(tfoot).toContain("Credit issued");
    expect(tfoot).toContain("CN-1042");
    expect(tfoot).toContain("$638.00");
    expect(tfoot).toContain("Balance Due");
    expect(tfoot).toContain("$232.00");
  });

  it("REG-B421: a cash + credit invoice shows BOTH an Amount Paid row and a separate Credit issued row", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 232,
      creditApplied: 638,
      advanceApplied: 0,
      creditNoteNumbers: ["CN-1042"],
      balanceDue: 0,
      isReminder: false,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).toContain("Amount Paid");
    expect(tfoot).toContain("$232.00");
    expect(tfoot).toContain("Credit issued");
    expect(tfoot).toContain("$638.00");
  });

  it("REG-B421: same as the credit-only case, for a reminder send", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 0,
      creditApplied: 638,
      advanceApplied: 0,
      creditNoteNumbers: ["CN-1042"],
      balanceDue: 232,
      isReminder: true,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).not.toContain("Amount Paid");
    expect(tfoot).toContain("Credit issued");
  });

  it("REG-B421: an advance-only invoice shows Advance applied, never Amount Paid", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...baseParams,
      totalPaid: 0,
      creditApplied: 0,
      advanceApplied: 100,
      balanceDue: 770,
      isReminder: false,
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const tfoot = tfootOf(html);
    expect(tfoot).not.toContain("Amount Paid");
    expect(tfoot).toContain("Advance applied");
    expect(tfoot).toContain("$100.00");
  });
});

/**
 * T-B103 / R9 / REG-B103 — PDF + email item payloads gain `originalPrice`,
 * `priceType`, `promoFreeUnits`; the email item row must show the struck-through
 * original price and an "N free" note on a BOGO line, mirroring the web invoice
 * detail renderer (apps/web/app/(dashboard)/invoices/[id]/page.tsx's
 * `{Number(item.promoFreeUnits)} free` text + `.strike` original-price markup —
 * email HTML has no external stylesheet, so the strike must be an inline
 * `text-decoration:line-through` or a semantic `<s>`/`<del>` tag instead of a CSS
 * class).
 *
 * Fixture: qty 6, 1 free unit, $10/unit, $12 original (pre-promo) — qty×unit−free
 * reconciles to the $50 stored subtotal: 10*(6-1) = 50, never the naive 10*6 = 60
 * a re-derive-from-qty bug would show.
 */
describe("EmailService.sendInvoice — BOGO/promo item display (T-B103, R9, REG-B103)", () => {
  const bogoItem = {
    description: "Widget (BOGO)",
    qty: 6,
    unitPrice: 10,
    subtotal: 50,
    originalPrice: 12,
    priceType: "PROMO",
    promoFreeUnits: 1,
  };

  function itemRowsOf(html: string): string {
    return (html.match(/<tbody>([\s\S]*?)<\/tbody>/) ?? ["", ""])[1];
  }

  it("REG-B103: the item row notes the free unit, strikes the original price, and keeps the $50 (not $60) subtotal", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      to: "buyer@example.com",
      customerName: "Acme Buyer",
      invoiceNumber: "INV-2002",
      invoiceId: "inv-2002",
      issueDate: "Jan 1, 2026",
      dueDate: "Jan 31, 2026",
      total: 50,
      totalPaid: 0,
      balanceDue: 50,
      items: [bogoItem],
    } as any);

    const html = sendSpy.mock.calls[0][0].html;
    const row = itemRowsOf(html);

    // BUY_N_GET_M note — same wording as the web reference ("1 free").
    expect(row).toContain("1 free");
    // Struck-through original per-unit price ($12), via either a semantic <s>
    // tag or an inline text-decoration:line-through — checked as two independent
    // acceptable shapes rather than one brittle combined regex.
    const hasSTag = /<s[^>]*>[^<]*\$12\.00/i.test(row);
    const hasInlineStrike = /text-decoration:\s*line-through/i.test(row) && row.includes("$12.00");
    expect(hasSTag || hasInlineStrike).toBe(true);
    // Reconciliation: qty×unit − free = 10*(6-1) = $50, the stored subtotal —
    // never the naive qty×unit = $60 a re-derive-from-qty bug would show.
    expect(row).toContain("$50.00");
    expect(row).not.toContain("$60.00");
  });

  it("REG-B103: hideOriginalPrice suppresses the strike — the tenant's hidden pre-promo price never reaches the buyer", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      to: "buyer@example.com",
      customerName: "Acme Buyer",
      invoiceNumber: "INV-2003",
      invoiceId: "inv-2003",
      issueDate: "Jan 1, 2026",
      dueDate: "Jan 31, 2026",
      total: 50,
      totalPaid: 0,
      balanceDue: 50,
      items: [bogoItem],
      // The tenant set invoice.hideOriginalPrice — the PDF attached to this very
      // message and the web detail page both show $10 only. The body must agree.
      hideOriginalPrice: true,
    } as any);

    const row = itemRowsOf(sendSpy.mock.calls[0][0].html);

    // The $12 pre-promo price is gone in every shape it could take.
    expect(row).not.toContain("$12.00");
    expect(row).not.toMatch(/text-decoration:\s*line-through/i);
    // …but the line is otherwise unchanged: the free-unit note and the charged
    // price/subtotal still render (hiding the base price is not hiding the promo).
    expect(row).toContain("1 free");
    expect(row).toContain("$10.00");
    expect(row).toContain("$50.00");
  });
});

/**
 * N4 — low-stock digest template. Deliberately built with `getTenantId: () => null` (no
 * ALS tenant context), matching how `LowStockDigestService`'s cron actually calls this —
 * that null tenantId is what routes `send()` to the platform sender (EMAIL_FROM) instead
 * of resolving tenant SMTP, per the N4 ground rule ("platform emails via EMAIL_FROM").
 */
describe("EmailService.sendLowStockDigest (N4)", () => {
  function makePlatformService(): EmailService {
    const config = {
      get: (k: string) =>
        k === "EMAIL_FROM" ? "RouteFlow <invoices@send.routeflow.info>" : undefined,
    } as any;
    const prisma = { getTenantId: () => null } as any;
    const encryption = { decrypt: (v: string) => v } as any;
    return new EmailService(config, prisma, encryption);
  }

  const items = [
    { name: "Acme Widget", sku: "WID-001", currentStock: 3, reorderPoint: 10 },
    { name: "Acme Gadget", sku: null, currentStock: 0, reorderPoint: 5 },
  ];

  it("REG-N4: subject names the item count, recipient and body carry the digest's key lines", async () => {
    const svc = makePlatformService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "resend" } as any);

    await svc.sendLowStockDigest({
      to: "admin@acme.example",
      businessName: "Acme Wholesale",
      items,
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0];
    expect(call.to).toBe("admin@acme.example");
    expect(call.subject).toBe("Low stock alert — 2 items below threshold");
    expect(call.html).toContain("Acme Wholesale");
    expect(call.html).toContain("Low Stock Alert");
    expect(call.html).toContain("Acme Widget");
    expect(call.html).toContain("WID-001");
    expect(call.html).toContain("Acme Gadget");
    // no SKU on file renders an em dash, never a blank/undefined cell
    expect(call.html).toContain("—");
  });

  it("REG-N4: a single item gets singular subject/body wording", async () => {
    const svc = makePlatformService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "resend" } as any);

    await svc.sendLowStockDigest({
      to: "admin@acme.example",
      businessName: "Acme Wholesale",
      items: [items[0]],
    });

    expect(sendSpy.mock.calls[0][0].subject).toBe("Low stock alert — 1 item below threshold");
    expect(sendSpy.mock.calls[0][0].html).toContain("1 item is below its reorder point");
  });

  it("REG-N4: a product name containing HTML is escaped, never injected raw", async () => {
    const svc = makePlatformService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "resend" } as any);

    await svc.sendLowStockDigest({
      to: "admin@acme.example",
      businessName: "Acme Wholesale",
      items: [
        { name: "<img src=x onerror=alert(1)>", sku: null, currentStock: 1, reorderPoint: 2 },
      ],
    });

    const html = sendSpy.mock.calls[0][0].html;
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("REG-N4: never resolves tenant SMTP — routes via the platform sender (no tenant ALS context)", async () => {
    const svc = makePlatformService();
    const res = await svc.sendLowStockDigest({
      to: "admin@acme.example",
      businessName: "Acme Wholesale",
      items,
    });
    // No RESEND_API_KEY and no tenant SMTP configured (getTenantId → null short-circuits
    // getTenantEmailConfig) → honest "not delivered, no transport", never a silent mock
    // success and never an attempt to read tenant-scoped config.
    expect(res).toMatchObject({ delivered: false, transport: "none" });
  });

  it("REG-N4: a large item list is capped at 100 rendered rows with an '…and N more' row, but the subject stays truthful about the real total", async () => {
    const svc = makePlatformService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "resend" } as any);
    const many = Array.from({ length: 137 }, (_, i) => ({
      name: `SKU ${i}`,
      sku: `S-${i}`,
      currentStock: 1,
      reorderPoint: 10,
    }));

    await svc.sendLowStockDigest({
      to: "admin@acme.example",
      businessName: "Acme Wholesale",
      items: many,
    });

    const call = sendSpy.mock.calls[0][0];
    expect(call.subject).toBe("Low stock alert — 137 items below threshold");
    expect(call.html).toContain("SKU 99");
    expect(call.html).not.toContain("SKU 100");
    expect(call.html).toContain("…and 37 more items");
  });
});
