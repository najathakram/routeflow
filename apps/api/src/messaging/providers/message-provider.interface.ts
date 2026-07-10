import { MessageChannel } from "@prisma/client";

export interface SendInput {
  tenantId: string | null;
  channel: MessageChannel;
  /** Destination: phone (SMS/WA), email (EMAIL), or user/portal id. */
  to: string;
  body: string;
  /** Meta-WA approved-template ref (P6-3); ignored by the stub. */
  templateName?: string;
}

export interface SendResult {
  providerMsgId: string;
  status: "queued" | "sent" | "failed";
}

/**
 * DI token for the outbound message provider. Default-bound to `StubProvider`
 * in P6-2; P6-3/P6-4 swap in Meta-WhatsApp / Twilio-SMS adapters behind this
 * token (env/flag gated) with NO change to the engine.
 */
export const MESSAGE_PROVIDER = "MESSAGE_PROVIDER";

export interface MessageProvider {
  /** Must NEVER throw — return `{ status: "failed" }` on internal error. */
  send(input: SendInput): Promise<SendResult>;
}
