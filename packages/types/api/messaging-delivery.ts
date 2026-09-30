// WS4 (SA-606) — shapes of the email delivery log + health endpoints
// (`GET /messaging/deliveries`, `GET /messaging/delivery-health`). The status enum is the shared
// `EMAIL_DELIVERY_STATUS_VALUES` (enums.ts, pinned to the Prisma enum by enum-parity.spec.ts) —
// never redeclared here (L-072).
import type { EmailDeliveryStatus } from "./enums";

/** Closed set of "how to fix it" keys a failed delivery error maps to (never the raw provider text). */
export const DELIVERY_FIX_KEY_VALUES = [
  "NO_FROM_ADDRESS",
  "MAILBOX_REVOKED",
  "SMTP_AUTH",
  "UNCONFIGURED",
  "OTHER",
] as const;
export type DeliveryFixKey = (typeof DELIVERY_FIX_KEY_VALUES)[number];

export interface DeliveryRow {
  id: string;
  kind: string;
  /** Full address for TENANT_ADMIN, masked (`j***@host`) for OPERATOR. */
  toAddress: string;
  status: EmailDeliveryStatus;
  error: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface DeliveryList {
  items: DeliveryRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface DeliveryHealth {
  windowDays: number;
  counts: Record<EmailDeliveryStatus, number>;
  failures: { fixKey: DeliveryFixKey; count: number }[];
}
