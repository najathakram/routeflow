import { randomBytes } from "crypto";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * W-1286 PR-1 (SA-1202): the record a later bounce is matched against. Three small helpers, no I/O of their own:
 * the Message-ID form (C3), the per-send reference token (C4') and the fallback class (C29). The reader that uses
 * them is PR-2; nothing here shows anything to a user.
 */

/** The header every RECORDED send carries (C4'). Brand-free on purpose, so a rebrand never touches it. */
export const DELIVERY_REF_HEADER = "X-Delivery-Ref";

/** Where a send left from. `transport` stays "smtp" for both SMTP paths, so it is never the route (C5). */
export const EMAIL_ROUTES = ["tenant-smtp", "platform-smtp", "mailbox", "resend", "none"] as const;
export type EmailRoute = (typeof EMAIL_ROUTES)[number];

/** Why a tenant-server send fell back, as a class only: never provider text, a host, a user or an address (C29). */
export const EMAIL_FALLBACK_CLASSES = ["AUTH", "CONNECT", "TLS", "OTHER"] as const;
export type EmailFallbackClass = (typeof EMAIL_FALLBACK_CLASSES)[number];

/** C3: brackets off, trimmed, lower case. The stored form and the form the lookup compares against. */
export function normalizeMessageId(raw: string): string {
  return raw
    .trim()
    .replace(/^<+|>+$/g, "")
    .trim()
    .toLowerCase();
}

/** C3: the bare and the bracketed form, so the existing `providerMessageId` index serves old and new rows. */
export function messageIdLookupForms(raw: string): string[] {
  const bare = normalizeMessageId(raw);
  return bare ? [bare, `<${bare}>`] : [];
}

/** C4': 128 random bits as 32 hex characters. Never the row id (a uuid), never derived from anything. */
export function newDeliveryRefToken(): string {
  return randomBytes(16).toString("hex");
}

type SmtpErrorLike = { message?: string; code?: string; responseCode?: number } | null | undefined;

const CONNECT_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKET",
  "ENOTFOUND",
  "EDNS",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
const TLS_CODES = new Set(["ETLS", "ESSL", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT"]);

/** C29: AUTH | CONNECT | TLS | OTHER. Reads the error to pick a class and returns only the class. */
export function classifyFallbackReason(err: SmtpErrorLike): EmailFallbackClass {
  const code = String(err?.code ?? "");
  const lower = String(err?.message ?? "").toLowerCase();
  if (
    code === "EAUTH" ||
    err?.responseCode === 535 ||
    err?.responseCode === 534 ||
    /\b535\b/.test(lower) ||
    lower.includes("invalid login") ||
    lower.includes("password not accepted")
  ) {
    return "AUTH";
  }
  if (TLS_CODES.has(code) || /certificate|\bssl\b|\btls\b|starttls/.test(lower)) return "TLS";
  if (CONNECT_CODES.has(code)) return "CONNECT";
  return "OTHER";
}

export type DeliveryLookup =
  { status: "MATCHED"; rows: { id: string; tenantId: string }[] } | { status: "UNMATCHED" };

/**
 * C3: the rows one Message-ID points at, by the Message-ID alone (never by recipient). No row = UNMATCHED, and this
 * function never writes. It runs without an ambient tenant (the bounce job has none), so the caller takes the tenant
 * from the matched rows and keeps every later write on `{ id, tenantId }` (C13).
 */
export async function lookupDeliveriesByMessageId(
  prisma: Pick<PrismaService, "emailDelivery">,
  rawMessageId: string,
): Promise<DeliveryLookup> {
  const forms = messageIdLookupForms(rawMessageId);
  if (forms.length === 0) return { status: "UNMATCHED" };
  const rows = await prisma.emailDelivery.findMany({
    where: { providerMessageId: { in: forms } },
    select: { id: true, tenantId: true },
  });
  return rows.length === 0 ? { status: "UNMATCHED" } : { status: "MATCHED", rows };
}
