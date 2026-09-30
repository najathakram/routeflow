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
function makeProvider(sendImpl: jest.Mock, businessName = "RouteFlow") {
  const emailService = {
    send: sendImpl,
    getTenantBusinessName: jest.fn().mockResolvedValue(businessName),
  } as unknown as EmailService;
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

  it("send() calls EmailService.send() with the subject + an HTML+text body, maps a delivered result to 'sent'", async () => {
    const send = jest.fn().mockResolvedValue({ delivered: true, transport: "smtp", id: "eml-1" });
    const provider = makeProvider(send, "Acme Distributors");

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
    expect(arg.text).toContain("Hi Acme Test Buyer, your order ORD-1 is confirmed.");
  });

  it("Opus review (N1): brands the email with the TENANT's business name, not a hard-coded 'RouteFlow'", async () => {
    const send = jest.fn().mockResolvedValue({ delivered: true, transport: "smtp", id: "eml-1" });
    const provider = makeProvider(send, "Acme Distributors");

    await provider.send({
      tenantId: "t1",
      channel: MessageChannel.EMAIL,
      to: "buyer@acme-test.example",
      body: "Hello",
      subject: "Order confirmed",
    });

    const arg = send.mock.calls[0][0];
    expect(arg.html).toContain("Acme Distributors");
    expect(arg.text).toContain("Acme Distributors");
  });

  it("Opus review (N1): escapes HTML-significant characters in the body (e.g. a customer name containing '<')", async () => {
    const send = jest.fn().mockResolvedValue({ delivered: true, transport: "smtp", id: "eml-1" });
    const provider = makeProvider(send);

    await provider.send({
      tenantId: "t1",
      channel: MessageChannel.EMAIL,
      to: "buyer@acme-test.example",
      body: "Hi Acme <script>alert(1)</script>, your order is confirmed.",
      subject: "Order confirmed",
    });

    const html = send.mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
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

  it("never throws even if getTenantBusinessName() itself rejects", async () => {
    const send = jest.fn();
    const emailService = {
      send,
      getTenantBusinessName: jest.fn().mockRejectedValue(new Error("db down")),
    } as unknown as EmailService;
    const provider = new EmailChannelProvider(emailService);

    await expect(
      provider.send({
        tenantId: "t1",
        channel: MessageChannel.EMAIL,
        to: "buyer@acme-test.example",
        body: "Hello",
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(send).not.toHaveBeenCalled();
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
