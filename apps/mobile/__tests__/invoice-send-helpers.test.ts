/**
 * Locks the post-delivery invoice-send deep-links + copy (mirror web's
 * SendInvoiceModal). Pure logic, node env — no RN/Linking needed.
 */
import {
  invoiceReadyMessage,
  preferredPhone,
  smsUrl,
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
