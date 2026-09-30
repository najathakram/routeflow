import { existsSync } from "fs";
import { join } from "path";
import { orderQrUrl } from "./invoice-qr";

/**
 * #2717 M3 (SA-579 Q3, owner decision): the invoice QR opens the ORDER in the web buyer portal:
 * `<WEB_URL>/buyer/portal/<tenant slug>/orders/<order id>`. One builder, so a change of target is a
 * one-line edit. No query or fragment (L-188), and no localhost fallback: an unset or scheme-less
 * WEB_URL means no QR, never a guessed origin.
 */
describe("orderQrUrl", () => {
  it("builds the buyer-portal order URL from WEB_URL, slug and order id", () => {
    expect(orderQrUrl("https://app.example.com", "acme", "ord-1")).toBe(
      "https://app.example.com/buyer/portal/acme/orders/ord-1",
    );
  });

  it("a trailing slash or a path prefix on the base is kept clean", () => {
    expect(orderQrUrl("https://app.example.com/", "acme", "o1")).toBe(
      "https://app.example.com/buyer/portal/acme/orders/o1",
    );
    expect(orderQrUrl("https://example.com/app/", "acme", "o1")).toBe(
      "https://example.com/app/buyer/portal/acme/orders/o1",
    );
  });

  it("never carries a query or a fragment, even when the base or the ids do", () => {
    const url = orderQrUrl("https://app.example.com/?utm=1#top", "a?b#c", "o?1#2") as string;
    expect(url).not.toMatch(/[?#]/);
    expect(url.startsWith("https://app.example.com/buyer/portal/")).toBe(true);
  });

  it.each([
    undefined,
    "",
    "   ",
    "app.example.com",
    "ftp://app.example.com",
    "javascript:alert(1)",
  ])("WEB_URL %p gives no QR (no localhost fallback)", (base) => {
    expect(orderQrUrl(base as string | undefined, "acme", "o1")).toBeNull();
  });

  it("no slug or no order id gives no QR", () => {
    expect(orderQrUrl("https://app.example.com", "", "o1")).toBeNull();
    expect(orderQrUrl("https://app.example.com", "acme", "")).toBeNull();
  });

  it("the target is a real route in the web app (the buyer-portal order detail page)", () => {
    const page = join(__dirname, "../../../web/app/buyer/portal/[seller]/orders/[id]/page.tsx");
    expect(existsSync(page)).toBe(true);
  });
});
