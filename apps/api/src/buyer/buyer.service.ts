import {
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { ConfigService } from "@nestjs/config";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import type { RequestSellerDto } from "./dto/request-seller.dto";

@Injectable()
export class BuyerService {
  private readonly logger = new Logger(BuyerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  // ─── Seller listing ───────────────────────────────────────────────────────────

  async getSellers(buyerAccountId: string) {
    const links = await this.prisma.customerLink.findMany({
      where: { buyerAccountId, status: { in: ["ACTIVE", "INVITED", "PENDING_SELLER_APPROVAL"] } },
      include: {
        tenant: {
          select: { id: true, name: true, slug: true },
        },
        customer: {
          select: { id: true, businessName: true, email: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Also fetch tenant branding separately
    const result = await Promise.all(
      links.map(async (link) => {
        const config = await this.prisma.tenantConfig.findFirst({
          where: { tenantId: link.tenantId },
          select: { businessName: true, logoKey: true, primaryColor: true },
        });
        return {
          linkId: link.id,
          linkStatus: link.status,
          linkedAt: link.linkedAt,
          tenant: {
            id: link.tenant.id,
            slug: link.tenant.slug,
            name: config?.businessName ?? link.tenant.name,
            logoKey: config?.logoKey ?? null,
            primaryColor: config?.primaryColor ?? null,
          },
          // SECURITY (F4 roster oracle): a buyer's own un-approved request must not
          // confirm the seller's customer identity back to them. Reveal customer
          // identity only once the link is ACTIVE; pending/invited rows show the
          // seller branding + status badge only.
          customer: link.status === "ACTIVE" ? link.customer : null,
        };
      }),
    );
    return result;
  }

  // ─── Invite details (public, no auth needed) ──────────────────────────────────

  async getInviteDetails(token: string) {
    const link = await this.prisma.customerLink.findUnique({
      where: { inviteToken: token },
      include: {
        tenant: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!link) throw new NotFoundException("Invite not found or already used");
    if (link.inviteExpiresAt && link.inviteExpiresAt < new Date()) {
      throw new GoneException("This invite link has expired");
    }
    // PENDING_SELLER_APPROVAL is also redeemable: a buyer-initiated request against an
    // INVITED row flips the status but PRESERVES inviteToken/inviteExpiresAt, and the
    // true invitee's emailed link must keep working (acceptInvite then flips the row to
    // ACTIVE under THEIR account). Any other status means the token was consumed.
    if (link.status !== "INVITED" && link.status !== "PENDING_SELLER_APPROVAL") {
      throw new ConflictException("This invite has already been used");
    }

    const tenantConfig = await this.prisma.tenantConfig.findFirst({
      where: { tenantId: link.tenantId },
      select: { businessName: true, logoKey: true, primaryColor: true },
    });

    return {
      sellerName: tenantConfig?.businessName ?? link.tenant.name,
      sellerSlug: link.tenant.slug,
      logoKey: tenantConfig?.logoKey ?? null,
      primaryColor: tenantConfig?.primaryColor ?? null,
      inviteMethod: link.inviteMethod,
      expiresAt: link.inviteExpiresAt,
    };
  }

  // ─── Accept invite ────────────────────────────────────────────────────────────

  async acceptInvite(token: string, buyerAccountId: string) {
    return this.prisma.$transaction(async (tx) => {
      const link = await tx.customerLink.findUnique({
        where: { inviteToken: token },
        include: { tenant: { select: { name: true, slug: true } } },
      });

      if (!link) throw new NotFoundException("Invite not found or already used");
      if (link.inviteExpiresAt && link.inviteExpiresAt < new Date()) {
        throw new GoneException("This invite link has expired");
      }
      // Same gate as getInviteDetails: a row still carrying the token is still redeemable
      // even after a buyer-initiated request moved it to PENDING_SELLER_APPROVAL. The
      // update below overwrites buyerAccountId with the token holder and clears the token.
      if (link.status !== "INVITED" && link.status !== "PENDING_SELLER_APPROVAL") {
        throw new ConflictException("This invite has already been used");
      }

      // Check if buyer already has a link to this tenant
      const existing = await tx.customerLink.findFirst({
        where: { buyerAccountId, tenantId: link.tenantId, id: { not: link.id } },
      });
      if (existing && existing.status === "ACTIVE") {
        throw new ConflictException("You are already connected to this seller");
      }

      const updated = await tx.customerLink.update({
        where: { id: link.id },
        data: {
          buyerAccountId,
          status: "ACTIVE",
          linkedAt: new Date(),
          inviteToken: null,
          inviteExpiresAt: null,
        },
        include: { tenant: { select: { name: true, slug: true } } },
      });

      this.logger.log(`BuyerAccount ${buyerAccountId} linked to tenant ${link.tenantId}`);

      return {
        message: `Successfully connected to ${link.tenant.name}`,
        tenantSlug: link.tenant.slug,
        linkId: updated.id,
      };
    });
  }

  // ─── Customer requests seller (buyer-initiated flow) ──────────────────────────

  async requestSeller(buyerAccountId: string, dto: RequestSellerDto) {
    const account = await this.prisma.buyerAccount.findUnique({
      where: { id: buyerAccountId },
      select: { email: true, name: true, emailVerified: true },
    });
    if (!account) throw new UnauthorizedException();
    const signInEmail = account.email.toLowerCase();

    // Resolve tenant
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: dto.sellerSlug } });
    if (!tenant) throw new NotFoundException("Seller not found");
    if (tenant.status === "SUSPENDED" || tenant.status === "CANCELLED") {
      throw new NotFoundException("Seller not found");
    }

    // Find customer at that tenant matching the email the buyer TYPED (a claim, not proof).
    // Check both the customer's own email field AND their linked User's login email.
    const claimedEmail = dto.emailAtSeller.toLowerCase();
    const customer = await this.prisma.customer.findFirst({
      where: {
        tenantId: tenant.id,
        OR: [{ email: claimedEmail }, { user: { email: claimedEmail } }],
      },
      include: { user: { select: { email: true } } },
    });
    if (!customer) {
      throw new NotFoundException(
        "No customer account found with that email at this seller. Contact the seller to send you an invite.",
      );
    }

    // Ownership is proven ONLY by the email the buyer AUTHENTICATED with.
    // `emailAtSeller` is a claim; auto-approving on it let any buyer type any
    // customer's email and instantly read their invoices and pricing.
    //
    // AND that sign-in email must be VERIFIED (mailbox proven). Registration alone
    // issues tokens without any mailbox check, so before this gate an attacker could
    // simply REGISTER under a victim customer's address and auto-connect. Now
    // `emailVerified` is set only by clicking the emailed link
    // (BuyerAuthService.verifyEmail), by Google sign-in (Google attests the mailbox),
    // or by the one-time migration that grandfathered accounts predating this gate
    // (20260823_add_buyer_email_verification — without it every existing password
    // buyer would have dropped into seller-review, since the flag was write-only).
    // An unverified match falls through to PENDING_SELLER_APPROVAL, never ACTIVE.
    const customerEmails = [customer.email, customer.user?.email]
      .filter(Boolean)
      .map((e) => String(e).toLowerCase());
    const signInEmailMatches = customerEmails.includes(signInEmail);
    const emailProven = signInEmailMatches && account.emailVerified;

    // Check for existing link
    const existing = await this.prisma.customerLink.findFirst({
      where: { customerId: customer.id },
    });
    if (existing) {
      if (existing.status === "ACTIVE" && existing.buyerAccountId === buyerAccountId) {
        throw new ConflictException("You are already connected to this seller");
      }
      if (existing.status === "ACTIVE" && existing.buyerAccountId !== buyerAccountId) {
        throw new ConflictException(
          "This customer account is already claimed by another buyer. Contact the seller.",
        );
      }
      // The PENDING branches apply ONLY while ownership is unproven. A buyer whose
      // SIGN-IN email is on the customer record falls through to the ACTIVE upsert below
      // and takes the pending row over — otherwise any stranger's un-proven request would
      // lock the legitimate owner out of self-connecting until the seller declined it.
      if (existing.status === "PENDING_SELLER_APPROVAL" && !emailProven) {
        if (existing.buyerAccountId === buyerAccountId) {
          // Idempotent no-op. No new writes, no re-notification, so a buyer can't spam
          // the seller's bell by resubmitting the same request.
          return {
            message: "Request already pending — the seller will review it soon.",
            linkId: existing.id,
            pending: true,
          };
        }
        throw new ConflictException(
          "This customer account already has a pending request from another buyer. Contact the seller.",
        );
      }
    }

    if (emailProven) {
      // The buyer proved ownership of this email by authenticating with it on the buyer
      // platform. Since the seller already has a customer record with this email, auto-approve
      // the connection immediately — no manual seller review needed. The upsert's `update`
      // path also covers taking over an INVITED row or a pending request (this buyer's own,
      // or a stranger's un-proven one) — the proven owner wins the single link slot.
      const now = new Date();
      const link = await this.prisma.customerLink.upsert({
        where: { customerId: customer.id },
        create: {
          buyerAccountId,
          customerId: customer.id,
          tenantId: tenant.id,
          status: "ACTIVE",
          linkedAt: now,
        },
        update: {
          buyerAccountId,
          status: "ACTIVE",
          linkedAt: now,
          inviteToken: null,
          inviteExpiresAt: null,
        },
      });

      this.logger.log(
        `BuyerAccount ${buyerAccountId} auto-approved link to tenant ${tenant.id} (customer ${customer.id}) via email match`,
      );

      this.gateway.emitBuyerAutoLinked(tenant.id, {
        customerId: customer.id,
        customerName: customer.businessName,
        buyerName: account.name,
        buyerEmail: account.email,
      });

      return {
        message: "Connected! You can now view your orders and invoices from this seller.",
        linkId: link.id,
      };
    }

    // Not proven — this becomes a request the seller must review, not a connection.
    // `update` (rather than a fresh create) when a row already exists — e.g. an
    // INVITED link — so inviteToken/inviteExpiresAt are left untouched and the true
    // invitee's link still works.
    //
    // ONLY an INVITED row keeps its token. Every other status is cleared, so a
    // token-bearing PENDING row provably descends from an outstanding invite: a
    // DISCONNECTED row can still carry the token of an invite the seller revoked (the
    // disconnect writers below clear it now, but rows disconnected before this fix do
    // not), and carrying that into PENDING would make getInviteDetails/acceptInvite
    // honour the revoked link again — and a later decline revert it to INVITED.
    const link = existing
      ? await this.prisma.customerLink.update({
          where: { id: existing.id },
          data:
            existing.status === "INVITED"
              ? { status: "PENDING_SELLER_APPROVAL", buyerAccountId }
              : {
                  status: "PENDING_SELLER_APPROVAL",
                  buyerAccountId,
                  inviteToken: null,
                  inviteExpiresAt: null,
                },
        })
      : // `customerId` is @unique, and two concurrent requests for the same customer both
        // read `existing === null` — upsert so the loser of that race resolves to the same
        // pending row instead of surfacing a raw P2002 as a 500.
        await this.prisma.customerLink.upsert({
          where: { customerId: customer.id },
          create: {
            status: "PENDING_SELLER_APPROVAL",
            buyerAccountId,
            tenantId: tenant.id,
            customerId: customer.id,
          },
          update: { status: "PENDING_SELLER_APPROVAL", buyerAccountId },
        });

    this.logger.log(
      `BuyerAccount ${buyerAccountId} requested access to customer ${customer.id} at tenant ${tenant.id} (${
        signInEmailMatches ? "sign-in email matches but is unverified" : "sign-in email unproven"
      } — pending seller approval)`,
    );

    const tenantConfig = await this.prisma.tenantConfig.findFirst({
      where: { tenantId: tenant.id },
      select: { businessName: true },
    });
    const sellerName = tenantConfig?.businessName ?? tenant.name;

    // Fire-and-forget both notification channels — email delivery must never fail
    // the request the buyer is waiting on.
    void this.notifySellerOfRequest(tenant.id, customer, account.email).catch((err) => {
      this.logger.warn(`Failed to email seller about buyer connect request: ${err}`);
    });
    this.gateway.emitBuyerConnectRequest(tenant.id, {
      customerId: customer.id,
      customerName: customer.businessName,
      buyerName: account.name,
      buyerEmail: account.email,
      requestedAt: new Date().toISOString(),
    });

    // A matching-but-unverified owner gets told the faster path. This leaks nothing:
    // the only way to hit it is signing in with the customer's email, and if that
    // account isn't the customer's, its holder registered it and knows the address.
    const needsEmailVerification = signInEmailMatches && !account.emailVerified;
    return {
      message: needsEmailVerification
        ? `Request sent — ${sellerName} will review it. Tip: your sign-in email matches this seller's records, so verifying it (check your inbox for the RouteFlow verification link) connects you instantly.`
        : `Request sent — ${sellerName} will review it. You'll see them in your seller list once approved.`,
      linkId: link.id,
      pending: true,
      ...(needsEmailVerification ? { needsEmailVerification: true } : {}),
    };
  }

  // ─── Operator: disconnect customer from buyer portal ──────────────────────────

  async disconnectPortal(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId },
    });
    if (!link || link.status === "DISCONNECTED") {
      return { message: "Customer is not connected to the buyer portal" };
    }

    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: {
        status: "DISCONNECTED",
        disconnectedBy: "SELLER",
        disconnectedAt: new Date(),
        // Disconnecting revokes the link — burn any outstanding invite token with it,
        // so it can never be redeemed or revived by a later connect request.
        inviteToken: null,
        inviteExpiresAt: null,
      },
    });

    this.logger.log(`Operator disconnected customer ${customerId} from buyer portal`);
    return { message: "Customer disconnected from buyer portal. All business data preserved." };
  }

  // ─── Operator: get portal status ─────────────────────────────────────────────

  async getPortalStatus(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId },
      include: {
        buyerAccount: { select: { id: true, email: true, name: true, createdAt: true } },
      },
    });

    if (!link) return { status: "NOT_INVITED", link: null };

    return {
      status: link.status,
      inviteMethod: link.inviteMethod,
      inviteExpiresAt: link.inviteExpiresAt,
      linkedAt: link.linkedAt,
      disconnectedAt: link.disconnectedAt,
      disconnectedBy: link.disconnectedBy,
      buyerAccount: link.status === "ACTIVE" ? link.buyerAccount : null,
    };
  }

  // ─── Operator: approve buyer seller request ───────────────────────────────────

  async approveBuyerRequest(customerId: string, tenantId: string) {
    const link = await this.prisma.customerLink.findFirst({
      where: { customerId, tenantId, status: "PENDING_SELLER_APPROVAL" },
    });
    if (!link) throw new NotFoundException("No pending buyer request found");

    await this.prisma.customerLink.update({
      where: { id: link.id },
      // Approving consumes the slot — any invite token the pending row inherited is spent.
      data: { status: "ACTIVE", linkedAt: new Date(), inviteToken: null, inviteExpiresAt: null },
    });

    return { message: "Buyer connection approved" };
  }

  // ─── Buyer: disconnect self from a seller ────────────────────────────────────

  async disconnectSelf(buyerAccountId: string, tenantSlug: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException("Seller not found");

    const link = await this.prisma.customerLink.findFirst({
      where: { buyerAccountId, tenantId: tenant.id },
    });
    if (!link || link.status === "DISCONNECTED") {
      return { message: "Not connected to this seller" };
    }

    await this.prisma.customerLink.update({
      where: { id: link.id },
      data: {
        status: "DISCONNECTED",
        disconnectedBy: "BUYER",
        disconnectedAt: new Date(),
        // See disconnectPortal: a severed link must not leave a redeemable token behind.
        inviteToken: null,
        inviteExpiresAt: null,
      },
    });

    return { message: "Disconnected from seller. Your order history remains accessible to them." };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async notifySellerOfRequest(
    tenantId: string,
    customer: { businessName: string; email: string | null },
    requestEmail: string,
  ) {
    // Get all operator users for this tenant to notify them
    const operators = await this.prisma.user.findMany({
      where: { tenantId, role: { in: ["OPERATOR", "TENANT_ADMIN"] }, status: "ACTIVE" },
      select: { email: true },
    });

    const tenantConfig = await this.prisma.tenantConfig.findFirst({
      where: { tenantId },
      select: { businessName: true },
    });
    const sellerName = tenantConfig?.businessName ?? "Your business";

    for (const op of operators.filter((o) => o.email)) {
      await this.emailService
        .send({
          to: op.email,
          subject: `Buyer portal connection request from ${requestEmail}`,
          html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2>New buyer connection request</h2>
            <p>A buyer with email <strong>${requestEmail}</strong> has requested to connect with your customer account <strong>${customer.businessName}</strong>.</p>
            <p>Log in to RouteFlow to approve or decline this request from the customer's portal status page.</p>
          </div>
        `,
        })
        .catch(() => {});
    }
  }
}
