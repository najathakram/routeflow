// #1965 (spec 10 / 08-C) — the ONE declaration of the notifications-page API additions:
//  - matrix fields (`audience`, `hasTrigger`, top-level `channelStatus`), served by
//    `GET /messaging/config` (additive: the existing `unavailable` codes stay);
//  - the email-delivery log + 7-day health shapes served by `GET /messaging/deliveries` and
//    `GET /messaging/delivery-health` (implemented by the salvage lane against THESE types).
// The web renders copy from these closed codes through a code->copy map; a raw provider string
// never crosses this boundary (`errorDetail` is server-side only and is deliberately absent).

/** Who receives an event's message. Every live customer event emails the buyer; internal alerts go to staff. */
export const NOTIFICATION_AUDIENCE_VALUES = ["CUSTOMER", "STAFF"] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCE_VALUES)[number];

/** Per-channel availability for the tenant: LIVE (transport bound), NOT_BUILT (no transport exists yet),
 *  NOT_CONFIGURED (transport exists but the tenant has not set it up). */
export const CHANNEL_STATUS_VALUES = ["LIVE", "NOT_BUILT", "NOT_CONFIGURED"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUS_VALUES)[number];

/** Customer-facing channels that appear in `channelStatus` (INTERNAL has no transport concept). */
export const CHANNEL_STATUS_CHANNEL_VALUES = ["EMAIL", "WHATSAPP", "SMS", "PORTAL"] as const;
export type ChannelStatusChannel = (typeof CHANNEL_STATUS_CHANNEL_VALUES)[number];
export type ChannelStatusMap = Record<ChannelStatusChannel, ChannelStatus>;

export const DELIVERY_STATUS_VALUES = ["SENT", "FAILED", "SKIPPED"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUS_VALUES)[number];

/** Closed reason set. SKIPPED: RULE_OFF | NO_RECIPIENT | OPTED_OUT. FAILED: the rest. */
export const DELIVERY_REASON_CODE_VALUES = [
  "RULE_OFF",
  "NO_RECIPIENT",
  "OPTED_OUT",
  "NO_FROM_ADDRESS",
  "TRANSPORT_ERROR",
  "RECIPIENT_REJECTED",
  "UNKNOWN",
] as const;
export type DeliveryReasonCode = (typeof DELIVERY_REASON_CODE_VALUES)[number];

/** Where the web sends the tenant to fix a reason. `NONE` = informational, no action. */
export const DELIVERY_FIX_LINK_VALUES = [
  "SETTINGS_EMAIL",
  "SETTINGS_NOTIFICATIONS",
  "MY_ACCOUNT",
  "NONE",
] as const;
export type DeliveryFixLink = (typeof DELIVERY_FIX_LINK_VALUES)[number];

/** One row of `GET /messaging/deliveries` (30 days, paged). `recipient` is the full address for
 *  admins and masked for operators (server-side). */
export interface DeliveryRow {
  id: string;
  createdAt: string; // ISO-8601
  eventKey: string; // NotificationEvent value
  status: DeliveryStatus;
  reasonCode: DeliveryReasonCode | null; // null when SENT
  recipient: string;
}

export interface DeliveriesPage {
  items: DeliveryRow[];
  nextCursor: string | null;
}

/** `GET /messaging/delivery-health` — trailing 7 days. `byReason` lists non-SENT outcomes only. */
export interface DeliveryHealth {
  windowDays: 7;
  sent: number;
  failed: number;
  skipped: number;
  byReason: Array<{ reasonCode: DeliveryReasonCode; count: number; fixLink: DeliveryFixLink }>;
}
