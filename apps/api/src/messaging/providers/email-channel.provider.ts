import { Injectable, Logger } from "@nestjs/common";
import { MessageChannel } from "@prisma/client";
import { EmailService } from "../../email/email.service";
import { MessageProvider, SendInput, SendResult } from "./message-provider.interface";
import {
  buildNotificationEmailHtml,
  buildNotificationEmailText,
} from "./email-notification-template";

/**
 * Real EMAIL transport for the messaging engine (N1, fixes B145/F23's
 * NO_TRANSPORT gap for EMAIL) — backed by `EmailService`, which already
 * resolves tenant-branded sender identity (platform/tenant SMTP or Resend, via
 * the B452 resolver) and NEVER throws for a delivery/config problem. WhatsApp/
 * SMS/PORTAL are NOT transported here — `transports()` declares EMAIL only, so
 * the engine's own NO_TRANSPORT gate (`messaging.service.ts` `sendMessage()`)
 * skips those honestly before `send()` is ever called for them, the same as
 * `StubProvider` did for every channel.
 */
@Injectable()
export class EmailChannelProvider implements MessageProvider {
  private readonly logger = new Logger(EmailChannelProvider.name);

  constructor(private readonly emailService: EmailService) {}

  async send(input: SendInput): Promise<SendResult> {
    if (input.channel !== MessageChannel.EMAIL) {
      // Unreachable in practice — transports() gates every other channel
      // upstream — but never fabricate a "sent" outcome for a channel this
      // provider doesn't actually transport.
      this.logger.error(
        `send() called for non-EMAIL channel ${input.channel} — this should never happen ` +
          "(transports() gates it upstream); returning failed.",
      );
      return { providerMsgId: `email-provider-skip-${input.channel}`, status: "failed" };
    }

    const subject = input.subject ?? "Update from RouteFlow";

    // EmailService.send() is documented as honest-by-result and never-throw
    // (R5), but MessageProvider.send()'s own contract is stricter — "MUST
    // NEVER throw" — and messaging.service.ts's sendMessage() has no try/catch
    // around provider.send(). Defense in depth: don't take EmailService's
    // contract on faith for a promise this interface makes explicitly. The
    // tenant-name lookup rides inside the same try — a DB hiccup there must
    // not throw out of this provider either.
    try {
      // Opus review (N1): the template hard-coded "RouteFlow" — this is
      // buyer-facing mail and must carry the SAME tenant brand invoice emails
      // do, not the platform's own name.
      const brandName = await this.emailService.getTenantBusinessName();
      const html = buildNotificationEmailHtml({ title: subject, bodyText: input.body, brandName });
      const text = buildNotificationEmailText({ title: subject, bodyText: input.body, brandName });
      const result = await this.emailService.send({ to: input.to, subject, html, text });
      if (!result.delivered) {
        this.logger.warn(
          `send to ${input.to} not delivered (transport=${result.transport}): ` +
            `${result.error ?? "no reason given"}`,
        );
        return { providerMsgId: result.id ?? `email-failed-${Date.now()}`, status: "failed" };
      }
      return { providerMsgId: result.id ?? `email-sent-${Date.now()}`, status: "sent" };
    } catch (err: any) {
      this.logger.error(`EmailService.send() threw unexpectedly: ${err?.message ?? err}`);
      return { providerMsgId: `email-error-${Date.now()}`, status: "failed" };
    }
  }

  /**
   * F23/B145 capability declaration: EMAIL only. Every other channel stays
   * NO_TRANSPORT exactly as it was under StubProvider — this provider does not
   * regress WhatsApp/SMS/PORTAL, it only turns EMAIL real.
   */
  transports(channel: MessageChannel): boolean {
    return channel === MessageChannel.EMAIL;
  }
}
