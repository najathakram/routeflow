import { MessageChannel } from "@prisma/client";

export interface SendInput {
  tenantId: string | null;
  channel: MessageChannel;
  /** Destination: phone (SMS/WA), email (EMAIL), or user/portal id. */
  to: string;
  body: string;
  /** Meta-WA approved-template ref (P6-3); ignored by the stub. */
  templateName?: string;
  /**
   * N1: email subject line, derived by the caller (`messaging.service.ts`'s
   * `notify()`) from `DEFAULT_TEMPLATES[eventKey].label` — ignored by every
   * non-EMAIL provider/channel.
   */
  subject?: string;
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
  /**
   * Capability declaration (F23/B145, cause-ruling.md §2): does this provider
   * actually transport `channel` to a real destination? The engine treats a
   * `"sent"` outcome as a promise that something left the building — it must
   * NOT infer that from `send()`'s `status` (e.g. `"queued"` is not a
   * delivery outcome). A provider that cannot yet deliver a channel MUST
   * declare it here so the engine can skip honestly (`NO_TRANSPORT`) instead
   * of fabricating a sent outcome.
   */
  transports(channel: MessageChannel): boolean;
}
