import { BadRequestException } from "@nestjs/common";
import { sendReminder } from "./invoice-reminder-email";

jest.mock("./invoice-email-payload", () => ({
  buildReminderEmailPayload: jest.fn((_inv: unknown, opts: { recipientEmail: string }) => ({
    to: opts.recipientEmail,
  })),
}));

/**
 * The reminder's recipient rule (moved verbatim out of InvoicesService): the request's override, else the customer's
 * on-file address, with import sentinels (`@imported.local` / `@placeholder.local`) treated as "no email". Driven
 * through `sendReminder` itself so replacing `resolveRecipientEmail` there with a plain `override || on-file` fails.
 */
const SENTINEL = "ghost@imported.local";

function deps(customerEmail: string | null) {
  const sendInvoice = jest.fn().mockResolvedValue({ delivered: true });
  const d = {
    prisma: {
      forTenant: () => ({
        invoice: {
          findUnique: jest.fn().mockResolvedValue({
            id: "inv-1",
            status: "SENT",
            total: 100,
            invoiceNumber: "INV-1",
            customer: { email: customerEmail },
            items: [],
            payments: [],
          }),
        },
      }),
    },
    emailService: { isEmailConfigured: jest.fn().mockResolvedValue(true), sendInvoice },
    pdfService: { getOrGenerate: jest.fn().mockResolvedValue(undefined) },
    storage: { download: jest.fn() },
    systemConfig: { get: jest.fn().mockResolvedValue(null) },
    logger: { warn: jest.fn() },
  };
  return { d: d as never, sendInvoice };
}

describe("sendReminder: who the reminder goes to", () => {
  it("sends to the override when it is routable", async () => {
    const { d, sendInvoice } = deps("on-file@example.com");
    const out = await sendReminder(d, "inv-1", "other@example.com");
    expect(out.sentTo).toBe("other@example.com");
    expect(sendInvoice).toHaveBeenCalledWith({ to: "other@example.com" });
  });

  it("falls back to the on-file address when there is no override", async () => {
    const { d } = deps("on-file@example.com");
    expect((await sendReminder(d, "inv-1")).sentTo).toBe("on-file@example.com");
  });

  it("a sentinel override (an older client echoing the import address) falls back to the on-file address", async () => {
    const { d } = deps("on-file@example.com");
    expect((await sendReminder(d, "inv-1", SENTINEL)).sentTo).toBe("on-file@example.com");
  });

  it("a sentinel on-file address is 'no email': a coded 400, nothing sent", async () => {
    const { d, sendInvoice } = deps(SENTINEL);
    await expect(sendReminder(d, "inv-1")).rejects.toThrow(BadRequestException);
    expect(sendInvoice).not.toHaveBeenCalled();
  });

  it("a sentinel override with no on-file address is also a 400", async () => {
    const { d } = deps(null);
    await expect(sendReminder(d, "inv-1", SENTINEL)).rejects.toThrow(/No email address on file/);
  });
});
