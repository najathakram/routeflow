import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface RegulatedGate {
  hiddenIds: Set<string>;
  locked: Array<{ id: string; name: string; status: string }>;
}

/**
 * Phase 4 (W7): the single source of truth for buyer-side regulated visibility —
 * shared by the catalog AND the dashboard so they can't drift (they did: the
 * dashboard's featured/new/suggested surfaces originally bypassed the gate).
 *
 * A category is HIDDEN when it `requiresLicense` and the buyer has no VERIFIED,
 * non-expired authorization for it. The predicate MATCHES the sale guard
 * (AuthorizationGuardService) — including gating regardless of the category's
 * `active` flag, because the guard blocks on `requiresLicense` alone (a
 * deactivated-but-still-requiresLicense category is still blocked at checkout, so
 * the buyer must not see its products). Two batched queries — no N+1; fast-paths
 * to empty when the tenant runs no license-required program.
 *
 * Known conservative gap: this over-hides relative to the guard's per-SALE allow
 * paths (an active §8 override, or an out-of-geo-scope delivery) — those need an
 * order/delivery context that doesn't exist at browse time, so we hide and let the
 * guard allow the actual purchase. Over-hiding is safe; under-hiding would leak.
 */
@Injectable()
export class RegulatedVisibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async computeGate(customerId: string, now = new Date()): Promise<RegulatedGate> {
    const gated = await this.prisma.forTenant().trackedCategory.findMany({
      where: { requiresLicense: true },
      select: { id: true, name: true },
    });
    if (gated.length === 0) return { hiddenIds: new Set(), locked: [] };

    const auths = await this.prisma.forTenant().customerAuthorization.findMany({
      where: { customerId, trackedCategoryId: { in: gated.map((c) => c.id) } },
      select: { trackedCategoryId: true, status: true, expiresAt: true },
    });
    const byId = new Map(auths.map((a) => [a.trackedCategoryId, a]));

    const hiddenIds = new Set<string>();
    const locked: Array<{ id: string; name: string; status: string }> = [];
    for (const c of gated) {
      const a = byId.get(c.id);
      const verified = a?.status === "VERIFIED" && (!a.expiresAt || new Date(a.expiresAt) > now);
      if (!verified) {
        hiddenIds.add(c.id);
        // A VERIFIED row past expiresAt reads as EXPIRED (the cron flips the
        // persisted status separately); no row → NONE.
        const status = a ? (a.status === "VERIFIED" ? "EXPIRED" : a.status) : "NONE";
        locked.push({ id: c.id, name: c.name, status });
      }
    }
    return { hiddenIds, locked };
  }
}
