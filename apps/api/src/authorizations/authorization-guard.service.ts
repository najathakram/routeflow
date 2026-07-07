import { ConflictException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuthorizationOverridesService } from "./authorization-overrides.service";
import { scopeApplies } from "./authorization-scope";

export interface BlockedCategory {
  trackedCategoryId: string;
  categoryName: string;
  reason: "NO_AUTH" | "EXPIRED";
}

export interface AuthCheckParams {
  customerId: string;
  lines: Array<{ trackedCategoryId: string | null }>;
  deliveryCity?: string | null;
  orderId?: string;
}

/**
 * Phase 4 (W6): the regulated-sale license guard. For each line's tracked category
 * that `requiresLicense`, the customer must hold a VERIFIED (non-expired)
 * authorization OR an active §8 override — otherwise the sale is blocked with a
 * structured 409 the client turns into the capture/override/remove modal.
 *
 * Warn-vs-block is driven ENTIRELY by `TrackedCategory.requiresLicense`: tobacco
 * seeds as `requiresLicense=false` and is therefore never gated here (its current
 * warn-only behavior is byte-identical). Enabling blocking is an explicit per-tenant
 * toggle, never an automatic flip. Expiry is evaluated LAZILY (expiresAt < now) so
 * the guard is correct even before the W7 cron flips a persisted status to EXPIRED.
 * This method is READ-ONLY — it never writes.
 */
@Injectable()
export class AuthorizationGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overrides: AuthorizationOverridesService,
  ) {}

  async checkAuthorized(params: AuthCheckParams): Promise<{ blocked: BlockedCategory[] }> {
    const categoryIds = [
      ...new Set(params.lines.map((l) => l.trackedCategoryId).filter(Boolean)),
    ] as string[];
    if (categoryIds.length === 0) return { blocked: [] }; // fast path: non-regulated order

    const cats = await this.prisma.forTenant().trackedCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true, requiresLicense: true, appliesScope: true },
    });
    const gated = cats.filter((c) => c.requiresLicense === true);
    if (gated.length === 0) return { blocked: [] }; // tobacco (requiresLicense=false) never blocks

    const now = new Date();
    const blocked: BlockedCategory[] = [];
    for (const c of gated) {
      // Out of geo-scope → this category doesn't gate this sale.
      if (c.appliesScope && !scopeApplies(c.appliesScope, params.deliveryCity)) continue;

      const auth = await this.prisma.forTenant().customerAuthorization.findUnique({
        where: {
          customerId_trackedCategoryId: {
            customerId: params.customerId,
            trackedCategoryId: c.id,
          },
        },
      });
      const verified = auth?.status === "VERIFIED";
      const expired = !!(verified && auth?.expiresAt && new Date(auth.expiresAt) < now);
      if (verified && !expired) continue;

      // An active §8 override satisfies the guard for its scope.
      if (await this.overrides.isOverrideActive(params.customerId, c.id, params.orderId)) continue;

      blocked.push({
        trackedCategoryId: c.id,
        categoryName: c.name,
        reason: expired ? "EXPIRED" : "NO_AUTH",
      });
    }
    return { blocked };
  }

  /** Throws a structured 409 (REGULATED_AUTH_REQUIRED) if any category is blocked. */
  async assertAuthorizedOrThrow(params: AuthCheckParams): Promise<void> {
    const { blocked } = await this.checkAuthorized(params);
    if (blocked.length > 0) {
      throw new ConflictException({ code: "REGULATED_AUTH_REQUIRED", blockedCategories: blocked });
    }
  }
}
