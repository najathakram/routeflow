import { READ_ONLY_STATUS } from "../../billing/dunning-config";
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { BLOCKED_SELLER_STATUSES, liveBuyerLinkWhere } from "../buyer-link-scope";
import type { BuyerJwtPayload } from "../interfaces/buyer-jwt-payload.interface";

/**
 * SA-733r6 (option a): the ONLY buyer writes a READ_ONLY seller still takes - the buyer paying what is owed. One named
 * constant of exact method + anchored route (the real route shapes), so an exemption is a reviewed one-line diff:
 * a card payment, a cash declaration, and the buyer cancelling their OWN pending request. Orders, the cart and every
 * other buyer write stay 403 SELLER_UNAVAILABLE. Staff approving a cash request is a staff payment write and stays
 * READ_ONLY at the tenant-status guard (unchanged).
 */
export const SELLER_READ_ONLY_EXEMPT_BUYER_WRITES: ReadonlyArray<{
  method: string;
  pattern: RegExp;
}> = [
  { method: "POST", pattern: /^\/api\/v1\/buyer\/payments\/card$/ },
  { method: "POST", pattern: /^\/api\/v1\/buyer\/payments\/cash$/ },
  { method: "POST", pattern: /^\/api\/v1\/buyer\/payments\/requests\/[^/]+\/cancel$/ },
  // SA ruling 10-11 A3: a buyer cancelling their OWN order reduces the seller's obligations, so it is exempt even
  // when the gate is enforced.
  { method: "POST", pattern: /^\/api\/v1\/buyer\/orders\/[^/]+\/cancel$/ },
];

/**
 * SA ruling 10-11 A3 (N6): the buyer-side READ_ONLY refusal ships DARK like every new behaviour gate.
 * `SELLER_READ_ONLY_BUYER_GATE` = `dark` (the default: allow, and log a `would_deny` line) | `enforced` (403
 * SELLER_UNAVAILABLE). It is separate from BILLING_PAUSE_MODE because a lapsed trial is READ_ONLY too. An unknown
 * value is `dark`: a typo can never turn the refusal on. The owner flips it after the READ_ONLY-sellers-with-buyers
 * count plus a week of would-deny log counts.
 */
export type SellerReadOnlyBuyerGate = "dark" | "enforced";
export function sellerReadOnlyBuyerGate(
  env: Record<string, string | undefined> = process.env,
): SellerReadOnlyBuyerGate {
  return (env.SELLER_READ_ONLY_BUYER_GATE ?? "").trim().toLowerCase() === "enforced"
    ? "enforced"
    : "dark";
}

/**
 * Resolves the buyer's active CustomerLink for the requested seller (X-Tenant-Slug).
 * Must run after BuyerJwtAuthGuard.
 * Sets req.buyerCustomer = { customerId, tenantId, tenantSlug, customer, userId }.
 */
@Injectable()
export class BuyerSellerContextGuard implements CanActivate {
  private readonly logger = new Logger(BuyerSellerContextGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const buyer = req.user as BuyerJwtPayload;
    const tenantSlug: string | undefined = req.headers["x-tenant-slug"];

    if (!tenantSlug) {
      throw new BadRequestException("X-Tenant-Slug header is required");
    }

    // Resolve tenant (unscoped — platform-level lookup)
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Seller not found");
    if (BLOCKED_SELLER_STATUSES.includes(tenant.status)) {
      throw new ForbiddenException("This seller account is not available");
    }

    // Verify active CustomerLink. REG-B141: removing a customer leaves its link ACTIVE on purpose (restore
    // must bring the portal back untouched), so the removal is enforced here, on every seller-scoped
    // request. No refresh-token revocation: BuyerRefreshToken is account-wide (no tenantId).
    // The predicate is shared with the realtime gateway's buyer rooms (B104) — see buyer-link-scope.ts.
    const link = await this.prisma.customerLink.findFirst({
      where: { ...liveBuyerLinkWhere(buyer.sub), tenantId: tenant.id },
      include: {
        customer: {
          select: { id: true, userId: true, businessName: true, email: true },
        },
      },
    });

    if (!link) {
      // REG-B141 observability: this 403 is indistinguishable from a DISCONNECTED link on the wire, and the
      // API logs no requests, so name the removed-customer case once here (refusal path only — the happy
      // path still issues exactly one query).
      const removed = await this.prisma.customerLink.findFirst({
        where: { buyerAccountId: buyer.sub, tenantId: tenant.id, status: "ACTIVE" },
        select: { customerId: true, customer: { select: { deletedAt: true } } },
      });
      if (removed?.customer?.deletedAt) {
        this.logger.warn(
          `[B141] portal access refused: customer ${removed.customerId} at tenant ${tenant.id} is removed (buyer ${buyer.sub})`,
        );
      }
      throw new ForbiddenException("No active connection to this seller");
    }

    // SA-733r6 (B4): a READ_ONLY seller (ANY reason) takes no buyer writes. The global TenantStatusGuard never sees a
    // buyer (a buyer token has no tenantId claim), so THIS guard is the server's authority; the buyer UI line is a
    // courtesy. Reads and the buyer's own payments (SELLER_READ_ONLY_EXEMPT_BUYER_WRITES) pass. Coded and neutral: a buyer is never told why, or anything about the seller's billing.
    const method = String(req.method ?? "GET").toUpperCase();
    const path = String(req.path ?? req.originalUrl ?? "").split("?")[0];
    const exempt = SELLER_READ_ONLY_EXEMPT_BUYER_WRITES.some(
      (e) => e.method === method && e.pattern.test(path),
    );
    if (
      tenant.status === READ_ONLY_STATUS &&
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      !exempt
    ) {
      if (sellerReadOnlyBuyerGate() === "enforced") {
        throw new ForbiddenException({
          code: API_ERROR_CODES.SELLER_UNAVAILABLE,
          message: "This seller isn't taking online orders right now. Please check back soon.",
        });
      }
      // dark: allow, and log what enforced would have refused (seller tenant id + route, no buyer data)
      this.logger.warn(
        `seller_read_only.would_deny code=${API_ERROR_CODES.SELLER_UNAVAILABLE} seller=${tenant.id} route=${method} ${path}`,
      );
    }

    // Populate request for downstream handlers / BuyerTenantInterceptor
    req.buyerCustomer = {
      customerId: link.customerId,
      tenantId: tenant.id,
      tenantSlug,
      // SA-733r6: the seller's status, so a buyer read can say "not taking online orders" (one boolean, no reason).
      sellerStatus: tenant.status,
      customer: link.customer,
      userId: link.customer.userId,
    };

    return true;
  }
}
