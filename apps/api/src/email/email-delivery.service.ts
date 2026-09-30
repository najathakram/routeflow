import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { EmailDeliveryStatus } from "@routeflow/types";
import type { EmailKind } from "./email-kinds";

const ERROR_MAX = 500;
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** Redact every email address and cap at 500 chars (provider text can echo recipients). */
export function sanitizeDeliveryError(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return String(raw).replace(EMAIL_RE, "<redacted>").slice(0, ERROR_MAX);
}

/** Optional `EmailService.send({ delivery })` context: asks for one audit row for that send. */
export interface EmailDeliveryContext {
  tenantId: string;
  kind: EmailKind;
  entityType?: string;
  entityId?: string;
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
}

/** Best-effort audit writer for outbound email attempts. Never stores a subject or body. */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Writes one row; NEVER throws (an audit failure must not change a send result). */
  async record(row: EmailDeliveryRecord): Promise<void> {
    try {
      await this.prisma.forTenant().emailDelivery.create({
        data: {
          tenantId: row.tenantId,
          kind: row.kind,
          toAddress: row.toAddress,
          entityType: row.entityType ?? null,
          entityId: row.entityId ?? null,
          status: row.status,
          providerMessageId: row.providerMessageId ?? null,
          error: sanitizeDeliveryError(row.error),
          attempts: row.attempts ?? (row.status === "SENT" || row.status === "FAILED" ? 1 : 0),
          sentAt: row.sentAt ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `EmailDelivery row not written (${row.kind}/${row.status}): ${sanitizeDeliveryError(
          (err as Error)?.message,
        )}`,
      );
    }
  }
}
