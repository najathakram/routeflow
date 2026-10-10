// #1965 (spec 10) — the ONE declaration of the notifications-page matrix additions, served by
// `GET /messaging/config` (additive: the existing `unavailable` codes stay): per-event `audience`
// and `hasTrigger`, and the top-level `channelStatus`. The email-delivery log / health shapes are
// NOT here: their status and reason enums are Prisma enums owned by the EmailDelivery bundle and
// mirrored in `enums.ts` (L-072).

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
