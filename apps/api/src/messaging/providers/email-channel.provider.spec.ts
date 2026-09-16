import { MessageChannel } from "@prisma/client";
import { EmailChannelProvider } from "./email-channel.provider";
import { EmailService } from "../../email/email.service";

/**
 * N1 — EmailChannelProvider is the messaging engine's real EMAIL transport,
 * backed by EmailService. Per the lead's framing, these tests mock
 * EmailService entirely (its own honesty/sender-resolution behavior is
 * covered by email.service.spec.ts) and pin only this provider's own
 * MessageProvider contract: transports() declares EMAIL only, send() never
 * throws, and a delivered/failed EmailService result maps to sent/failed.
 */
function makeProvider(sendImpl: jest.Mock) {
  const emailService = { send: sendImpl } as unknown as EmailService;
  return new EmailChannelProvider(emailService);
}

describe("EmailChannelProvider", () => {
  it("transports() declares EMAIL only — every other channel stays false (no regression vs StubProvider)", () => {
    const provider = makeProvider(jest.fn());
    expect(provider.transports(MessageChannel.EMAIL)).toBe(true);
    expect(provider.transports(MessageChannel.WHATSAPP)).toBe(false);
    expect(provider.transports(MessageChannel.SMS)).toBe(false);
    expect(provider.transports(MessageChannel.PORTAL)).toBe(false);
    expect(provider.transports(MessageChannel.INTERNAL)).toBe(false);
  });

  it("send() calls EmailService.send() with the subject + an HTML body, maps a delivered result to 'sent'", async () => {
    const send = jest.fn().mockResolvedValue({ delivered: true, transport: "smtp", id: "eml-1" });
    const provider = makeProvider(send);

    const result = await provider.send({
      tenantId: "t1",
      channel: MessageChannel.EMAIL,
      to: "buyer@acme-test.example",
      body: "Hi Acme Test Buyer, your order ORD-1 is confirmed.",
      subject: "Order confirmed",
    });

    expect(result).toEqual({ providerMsgId: "eml-1", status: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.to).toBe("buyer@acme-test.example");
    expect(arg.subject).toBe("Order confirmed");
    expect(arg.html).toContain("Hi Acme Test Buyer, your order ORD-1 is confirmed.");
    expect(arg.html).toContain("<!DOCTYPE html>");
  });

  it("falls back to a generic subject when the caller didn't supply one", async () => {
    const send = jest.fn().mockResolvedValue({ delivered: true, transport: "resend", id: "eml-2" });
    const provider = makeProvider(send);

    await provider.send({
      tenantId: "t1",
      channel: MessageChannel.EMAIL,
      to: "buyer@acme-test.example",
      body: "Hello",
    });

    expect(send.mock.calls[0][0].subject).toBe("Update from RouteFlow");
  });

  it("maps a not-delivered EmailService result to 'failed' — never throws, matches the MessageProvider contract", async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ delivered: false, transport: "none", error: "not configured" });
    const provider = makeProvider(send);

    const result = await provider.send({
      tenantId: "t1",
      channel: MessageChannel.EMAIL,
      to: "buyer@acme-test.example",
      body: "Hello",
    });

    expect(result.status).toBe("failed");
    expect(typeof result.providerMsgId).toBe("string");
  });

  it("never throws even if EmailService.send() itself rejects (MessageProvider's own contract, defense in depth beyond EmailService's documented never-throw)", async () => {
    const send = jest.fn().mockRejectedValue(new Error("unexpected"));
    const provider = makeProvider(send);

    await expect(
      provider.send({
        tenantId: "t1",
        channel: MessageChannel.EMAIL,
        to: "buyer@acme-test.example",
        body: "Hello",
      }),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("returns 'failed' without calling EmailService for a non-EMAIL channel (defensive — transports() should have gated this upstream)", async () => {
    const send = jest.fn();
    const provider = makeProvider(send);

    const result = await provider.send({
      tenantId: "t1",
      channel: MessageChannel.WHATSAPP,
      to: "+15550001111",
      body: "Hello",
    });

    expect(result.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });
});
