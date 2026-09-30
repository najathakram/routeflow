/**
 * Locks the post-delivery invoice-send deep-links + copy (mirror web's
 * SendInvoiceModal). Pure logic, node env — no RN/Linking needed.
 */
import {
  invoiceReadyMessage,
  nextPdfSharePhase,
  planWhatsAppSend,
  preferredPhone,
  smsUrl,
  smtpFallbackNotice,
  whatsappUrl,
} from "../lib/invoice-send-logic";

describe("invoiceReadyMessage", () => {
  it("matches web's verbatim copy (name + number + total, no PDF link)", () => {
    expect(invoiceReadyMessage("Acme Foods", "INV-1042", "$210.50")).toBe(
      "Hi Acme Foods, your invoice INV-1042 for $210.50 is ready. Please let us know if you have any questions.",
    );
  });
});

describe("whatsappUrl", () => {
  it("strips the phone to bare digits and URL-encodes the message", () => {
    expect(whatsappUrl("+1 (555) 234-9000", "Hi there!")).toBe(
      "https://wa.me/15552349000?text=Hi%20there!",
    );
  });
  it("encodes reserved characters in the body", () => {
    expect(whatsappUrl("15550000000", "A & B ready?")).toContain("?text=A%20%26%20B%20ready%3F");
  });
});

describe("smsUrl", () => {
  it("defaults to ?body= (Android/other) and encodes the message", () => {
    expect(smsUrl("+15550000000", "Invoice ready")).toBe("sms:+15550000000?body=Invoice%20ready");
  });
  it("uses &body= on iOS (caller passes the separator)", () => {
    expect(smsUrl("+15550000000", "Invoice ready", "&")).toBe(
      "sms:+15550000000&body=Invoice%20ready",
    );
  });
});

describe("preferredPhone", () => {
  it("prefers mobile over the landline", () => {
    expect(preferredPhone("555-1111", "555-2222")).toBe("555-1111");
  });
  it("falls back to phone when mobile is blank/whitespace/null", () => {
    expect(preferredPhone("   ", "555-2222")).toBe("555-2222");
    expect(preferredPhone(null, "555-2222")).toBe("555-2222");
    expect(preferredPhone(undefined, "555-2222")).toBe("555-2222");
  });
  it("returns undefined when neither is usable", () => {
    expect(preferredPhone(null, undefined)).toBeUndefined();
    expect(preferredPhone("  ", "")).toBeUndefined();
  });
});

describe("planWhatsAppSend", () => {
  // THE TRAP this batch fixes: never `await` a fetch between the tap and
  // `navigator.share()`. planWhatsAppSend is the pure decision of WHICH way
  // to send — file-share (attach the actual PDF, owner decision "WhatsApp =
  // PDF via share sheet") vs. the wa.me text-link fallback — kept separate
  // from the actual fetch/share timing (share-pdf.ts owns that).
  const input = { phone: "+1 (555) 234-9000", message: "Hi there!" };

  it("file ready: attaches the PDF when this device can share files", () => {
    const plan = planWhatsAppSend({ ...input, canShareFiles: true });
    expect(plan).toEqual({ mode: "share-file", text: "Hi there!" });
  });

  it("file not ready: falls back to the wa.me text link when file sharing isn't supported", () => {
    const plan = planWhatsAppSend({ ...input, canShareFiles: false });
    expect(plan).toEqual({
      mode: "text-link",
      url: "https://wa.me/15552349000?text=Hi%20there!",
    });
  });

  it("share rejected: canShare() declining files is treated exactly like unsupported — safe fallback, not a throw", () => {
    // canShareFilesHere() folds "no navigator.share" and "canShare() said no"
    // into the same `false` — planWhatsAppSend must react identically either way.
    const plan = planWhatsAppSend({ ...input, canShareFiles: false });
    expect(plan.mode).toBe("text-link");
  });
});

describe("smtpFallbackNotice", () => {
  // A send Resend rescued still succeeded — but the operator's own mailbox is
  // broken and the From address silently changed. Mobile discarded both before
  // this batch; the copy is web's verbatim so the two surfaces agree.
  it("discloses the reason AND the platform From address", () => {
    expect(
      smtpFallbackNotice({
        warning: "Microsoft 365 rejected the login — enable Authenticated SMTP",
        fromAddress: "invoices@routeflow.info",
      }),
    ).toBe(
      "Sent via RouteFlow's mail service (from invoices@routeflow.info) — your own email couldn't send: Microsoft 365 rejected the login — enable Authenticated SMTP.",
    );
  });

  it("omits the From clause when the address is missing", () => {
    expect(smtpFallbackNotice({ warning: "Connection timed out" })).toBe(
      "Sent via RouteFlow's mail service — your own email couldn't send: Connection timed out.",
    );
  });

  it("returns null when the tenant's own SMTP worked (nothing to disclose)", () => {
    expect(smtpFallbackNotice({})).toBeNull();
    expect(smtpFallbackNotice({ fromAddress: "invoices@routeflow.info" })).toBeNull();
  });
});

describe("nextPdfSharePhase", () => {
  it('only "ready-await-tap" arms a second tap', () => {
    expect(nextPdfSharePhase("ready-await-tap")).toBe("ready");
  });
  it("every other outcome resolves the flow back to idle", () => {
    expect(nextPdfSharePhase("shared")).toBe("idle");
    expect(nextPdfSharePhase("opened-tab")).toBe("idle");
    expect(nextPdfSharePhase("failed")).toBe("idle");
  });
});
