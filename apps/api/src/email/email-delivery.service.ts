import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { EmailDeliveryStatus } from "@routeflow/types";
import type { EmailKind } from "./email-kinds";
import { redactAddresses } from "./redact-addresses";
import {
  normalizeMessageId,
  type EmailFallbackClass,
  type EmailRoute,
} from "./bounces/email-bounce-keys";

const ERROR_MAX = 500;

/** Mask addresses (local part masked, domain kept) and IP literals via `redactAddresses`, then cap at 500 chars (provider text can echo recipients). */
export function sanitizeDeliveryError(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return redactAddresses(String(raw)).slice(0, ERROR_MAX);
}

/** Optional `EmailService.send({ delivery })` context: asks for one audit row for that send. */
export interface EmailDeliveryContext {
  tenantId: string;
  kind: EmailKind;
  entityType?: string;
  entityId?: string;
  /**
   * W-1286 (SA-1202 C6): the other entities one email is about (a completion email names several invoices). Each gets
   * its own row with the same status, route and message id; only the first row carries the unique `refToken`.
   */
  alsoEntityIds?: string[];
}

export interface EmailDeliveryRecord {
  tenantId: string;
  kind: EmailKind;
  toAddress: string;
  entityType?: string | null;
  entityId?: string | null;
  status: EmailDeliveryStatus;
  providerMessageId?: string | null;
  error?: string | null;
  attempts?: number;
  sentAt?: Date | null;
  /** C6: see EmailDeliveryContext.alsoEntityIds. */
  alsoEntityIds?: string[];
  /** C5: the route the send took. C4': the per-send reference token. C29: the fallback class, never provider text. */
  route?: EmailRoute | null;
  refToken?: string | null;
  fallbackReason?: EmailFallbackClass | null;
}

/** Best-effort audit writer for outbound email attempts. Never stores a subject or body. */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes one row; NEVER throws (an audit failure must not change a send result). */
  async record(row: EmailDeliveryRecord): Promise<void> {
    try {
      const db = this.prisma.forTenant();
      const ids = [row.entityId ?? null, ...(row.alsoEntityIds ?? [])].filter(
        (id, i, all) => all.indexOf(id) === i,
      );
      for (const [i, entityId] of ids.entries()) {
        await db.emailDelivery.create({
          data: {
            tenantId: row.tenantId,
            kind: row.kind,
            toAddress: row.toAddress,
            entityType: row.entityType ?? null,
            entityId,
            status: row.status,
            // C3: the bare form (brackets off, lower case); the lookup asks for both forms.
            providerMessageId: row.providerMessageId
              ? normalizeMessageId(row.providerMessageId)
              : null,
            error: sanitizeDeliveryError(row.error),
            attempts: row.attempts ?? (row.status === "SENT" || row.status === "FAILED" ? 1 : 0),
            sentAt: row.sentAt ?? null,
            route: row.route ?? null,
            // `refToken` is unique: the first row holds it, the siblings are found by the shared message id.
            refToken: i === 0 ? (row.refToken ?? null) : null,
            fallbackReason: row.fallbackReason ?? null,
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `EmailDelivery row not written (${row.kind}/${row.status}): ${sanitizeDeliveryError(
          (err as Error)?.message,
        )}`,
      );
    }
  }
}
