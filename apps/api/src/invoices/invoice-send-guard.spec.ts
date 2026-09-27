import { InvoiceStatus } from "@prisma/client";
import {
  VOIDED_DURING_EMAIL,
  lockInvoiceRow,
  nextSentStatus,
  sendRefusal,
  voidRefusal,
} from "./invoice-send-guard";

// #2255 / SA-404: the send/void decisions as pure guards + the lock-then-re-read first statement.
describe("invoice-send-guard", () => {
  it("sendRefusal refuses only a VOID invoice", () => {
    expect(sendRefusal(InvoiceStatus.VOID)).toBe("Cannot send a voided invoice");
    for (const s of [
      InvoiceStatus.DRAFT,
      InvoiceStatus.SENT,
      InvoiceStatus.PAID,
      InvoiceStatus.PARTIAL,
    ])
      expect(sendRefusal(s)).toBeNull();
  });

  it("SA-404a: a VOID found AFTER the email went out says the customer received it", () => {
    expect(sendRefusal(InvoiceStatus.VOID, true)).toBe(VOIDED_DURING_EMAIL);
    expect(VOIDED_DURING_EMAIL).toMatch(/customer received the email; nothing was marked sent/);
    expect(sendRefusal(InvoiceStatus.SENT, true)).toBeNull();
  });

  it("nextSentStatus flips only DRAFT → SENT and never downgrades PAID/PARTIAL", () => {
    expect(nextSentStatus(InvoiceStatus.DRAFT)).toBe(InvoiceStatus.SENT);
    expect(nextSentStatus(InvoiceStatus.PAID)).toBe(InvoiceStatus.PAID);
    expect(nextSentStatus(InvoiceStatus.PARTIAL)).toBe(InvoiceStatus.PARTIAL);
    expect(nextSentStatus(InvoiceStatus.SENT)).toBe(InvoiceStatus.SENT);
  });

  it("voidRefusal refuses external money above the cent tolerance, with the existing message", () => {
    expect(voidRefusal(0)).toBeNull();
    expect(voidRefusal(0.001)).toBeNull();
    expect(voidRefusal(40)).toBe(
      "Cannot void an invoice with $40.00 in cash/check/card payments. Reverse or refund those payments first.",
    );
  });

  it("lockInvoiceRow locks Order then Invoice (SA-214 order) BEFORE it re-reads the invoice", async () => {
    const order: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        order.push(strings.join("?").includes('"Order"') ? "lock Order" : "lock Invoice");
      }),
      invoice: {
        findUnique: jest.fn(async () => {
          order.push("read Invoice");
          return { id: "i1" };
        }),
      },
    };
    await lockInvoiceRow(tx, "i1", "o1");
    expect(order).toEqual(["lock Order", "lock Invoice", "read Invoice"]);
    order.length = 0;
    await lockInvoiceRow(tx, "i1", null); // no order ⇒ the Invoice lock is the first statement
    expect(order).toEqual(["lock Invoice", "read Invoice"]);
  });
});
