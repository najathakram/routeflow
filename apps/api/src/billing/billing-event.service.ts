import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BillingEventType } from "./plan-catalog.constants";

/**
 * Append-only billing audit log + MRR source of truth. Every plan/addon/seat/
 * grace/trial transition emits one row; the platform-admin MRR rollup (Phase 6)
 * reconciles against `amountDelta` (the monthly run-rate change, in dollars).
 */
@Injectable()
export class BillingEventService {
  constructor(private readonly prisma: PrismaService) {}

  emit(
    tenantId: string,
    type: BillingEventType,
    payload: Prisma.InputJsonValue,
    opts?: {
      amountDelta?: number | null;
      actorId?: string | null;
      /** Join an enclosing transaction so state-write + audit row are atomic. */
      tx?: Prisma.TransactionClient;
    },
  ) {
    const db = opts?.tx ?? this.prisma;
    return db.billingEvent.create({
      data: {
        tenantId,
        type,
        payload,
        amountDelta: opts?.amountDelta ?? null,
        actorId: opts?.actorId ?? null,
      },
    });
  }
}
