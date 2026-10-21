import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { withCurrentState, type PaymentKeyScope } from "./payment-idempotency";

/**
 * SA-824 (SA condition a/b): GET /invoices/payments/by-key/:key. A DEFINITIVE answer about a payment
 * Idempotency-Key, for a dialog whose outcome is unknown (a lost response): the stored result with each
 * payment's CURRENT status (the same re-read a replay does), or 404 PAYMENT_KEY_NOT_FOUND (nothing is
 * recorded under the key, so the client may release it). Tenant-scoped, read-only, one endpoint for the
 * three scopes (standalone, per-invoice, direct advance).
 */
@Injectable()
export class PaymentKeyStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async byKey(key: string) {
    // forTenant() is UNSCOPED without a tenant: refuse, like the writers.
    if (!this.prisma.getTenantId()) {
      throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
    }
    const row = await this.prisma.forTenant().paymentIdempotencyKey.findFirst({
      where: { key },
      select: { scope: true, result: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: API_ERROR_CODES.PAYMENT_KEY_NOT_FOUND,
        message: "No payment is recorded under this key",
      });
    }
    const scope = row.scope as PaymentKeyScope;
    const stored = await withCurrentState(this.prisma, scope, row.result);
    return { ...stored, scope, replayed: true as const };
  }
}
