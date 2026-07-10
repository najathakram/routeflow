import { Injectable, Logger } from "@nestjs/common";
import { MessageProvider, SendInput, SendResult } from "./message-provider.interface";

/**
 * Default outbound provider (P6-2). Logs the send and returns a synthetic id —
 * no network, no external account, builds/tests/deploys at $0. Never throws, so
 * the engine's record + meter steps always run. Real Meta-WA/Twilio adapters
 * replace this at the MESSAGE_PROVIDER token in P6-3/P6-4.
 */
@Injectable()
export class StubProvider implements MessageProvider {
  private readonly logger = new Logger(StubProvider.name);
  private seq = 0;

  async send(input: SendInput): Promise<SendResult> {
    const providerMsgId = `stub-${input.channel}-${++this.seq}`;
    this.logger.log(
      `[stub] channel=${input.channel} to=${input.to} tenant=${input.tenantId ?? "-"} ` +
        `tmpl=${input.templateName ?? "-"} body="${input.body.slice(0, 80)}" -> ${providerMsgId}`,
    );
    return { providerMsgId, status: "queued" };
  }
}
