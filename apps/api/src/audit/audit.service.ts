import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface CreateAuditLogDto {
  tenantId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  ip?: string | null;
  meta?: Record<string, unknown>;
  /** Platform-admin id when the write happened under impersonation (AuditLog.impersonatedBy, F01). */
  impersonatedBy?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(dto: CreateAuditLogDto): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: dto.tenantId,
          userId: dto.userId,
          action: dto.action,
          entityType: dto.entityType,
          entityId: dto.entityId ?? null,
          ip: dto.ip ?? null,
          impersonatedBy: dto.impersonatedBy ?? null,
          meta: (dto.meta as any) ?? undefined,
        },
      });
    } catch (err: any) {
      // Audit log failures must never crash the main request — but a silent
      // catch left a DB hiccup indistinguishable from "no action happened",
      // on the exact trail (B138/B165) the impersonation audit chain relies
      // on to name who really acted. Log it; still never rethrow.
      this.logger.error(
        `Failed to write audit log (action=${dto.action}, entityType=${dto.entityType}, ` +
          `tenantId=${dto.tenantId ?? "null"}): ${err?.message ?? err}`,
      );
    }
  }
}
