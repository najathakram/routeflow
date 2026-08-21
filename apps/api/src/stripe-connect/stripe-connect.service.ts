import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "../billing/stripe.service";
import { AppConfig } from "../config/configuration";

/**
 * Stripe Connect (Standard accounts, direct charges, no platform fee).
 *
 * A tenant links the Stripe account they already own through the Connect OAuth
 * flow; buyer card payments are then created ON that account (`stripeAccount`
 * option per call), so the funds, the Stripe customer and the dispute all live
 * with the tenant. RouteFlow's platform key only brokers the OAuth exchange and
 * reads account status.
 *
 * The OAuth `state` is a short-lived JWT naming the tenant, signed with the
 * app's own secret — the callback trusts it and NOTHING else. Without this, a
 * crafted callback URL could bind one tenant's Stripe account to another
 * tenant (the callback is necessarily public: Stripe redirects the browser to
 * it without our auth headers).
 */
@Injectable()
export class StripeConnectService {
  private readonly logger = new Logger(StripeConnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService<AppConfig>,
    private readonly jwt: JwtService,
  ) {}

  private get clientId(): string {
    return this.config.get<AppConfig["stripe"]>("stripe")?.connectClientId ?? "";
  }

  /** The API's public base URL — the registered OAuth redirect must match it. */
  private get apiPublicUrl(): string {
    return (process.env.API_PUBLIC_URL ?? "https://routeflowapi-production.up.railway.app").replace(
      /\/$/,
      "",
    );
  }

  get redirectUri(): string {
    return `${this.apiPublicUrl}/api/v1/settings/stripe-connect/callback`;
  }

  get isConfigured(): boolean {
    return this.stripe.isConfigured && this.clientId.length > 0;
  }

  /** Current link status for the settings card. Never throws on "not connected". */
  async getStatus(tenantId: string) {
    const row = await this.prisma.tenantStripeConnect.findUnique({ where: { tenantId } });
    const connected = !!row && !row.disconnectedAt;
    return {
      configured: this.isConfigured,
      connected,
      stripeAccountId: connected ? row.stripeAccountId : null,
      chargesEnabled: connected ? row.chargesEnabled : false,
      detailsSubmitted: connected ? row.detailsSubmitted : false,
      livemode: connected ? row.livemode : false,
      connectedAt: connected ? row.connectedAt : null,
    };
  }

  /** Build the Stripe OAuth authorize URL, carrying a signed tenant-bound state. */
  async buildAuthorizeUrl(tenantId: string, startedByName?: string | null): Promise<string> {
    if (!this.isConfigured) {
      throw new BadRequestException(
        "Stripe Connect is not configured on this platform yet (STRIPE_SECRET_KEY / STRIPE_CONNECT_CLIENT_ID).",
      );
    }
    const state = await this.jwt.signAsync(
      { purpose: "stripe-connect", tid: tenantId, by: startedByName ?? null },
      { expiresIn: "15m" },
    );
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      scope: "read_write",
      redirect_uri: this.redirectUri,
      state,
    });
    return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * OAuth callback: verify the state, exchange the code, store the account.
   * Returns the connected account summary for the redirect. All failures throw
   * BadRequestException with an operator-readable message.
   */
  async completeOAuth(code: string, state: string) {
    let payload: { purpose?: string; tid?: string; by?: string | null };
    try {
      payload = await this.jwt.verifyAsync(state);
    } catch {
      throw new BadRequestException("Connect link expired or invalid — start again from Settings.");
    }
    if (payload.purpose !== "stripe-connect" || !payload.tid) {
      throw new BadRequestException("Invalid connect state.");
    }
    const tenantId = payload.tid;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) throw new BadRequestException("Unknown tenant.");

    const client = this.stripe.client;
    let token: any;
    try {
      token = await client.oauth.token({ grant_type: "authorization_code", code });
    } catch (err: any) {
      this.logger.warn(`Connect OAuth exchange failed for ${tenant.slug}: ${err?.message}`);
      throw new BadRequestException("Stripe rejected the connect code — try linking again.");
    }
    const accountId: string = token?.stripe_user_id;
    if (!accountId) throw new BadRequestException("Stripe returned no account id.");

    // Account status now, so chargesEnabled is correct before the first
    // account.updated webhook arrives.
    let acct: any = null;
    try {
      acct = await client.accounts.retrieve(accountId);
    } catch (err: any) {
      this.logger.warn(`accounts.retrieve(${accountId}) failed: ${err?.message}`);
    }

    const row = await this.prisma.tenantStripeConnect.upsert({
      where: { tenantId },
      create: {
        tenantId,
        stripeAccountId: accountId,
        livemode: !!token.livemode,
        chargesEnabled: !!acct?.charges_enabled,
        detailsSubmitted: !!acct?.details_submitted,
        connectedByName: payload.by ?? null,
      },
      update: {
        stripeAccountId: accountId,
        livemode: !!token.livemode,
        chargesEnabled: !!acct?.charges_enabled,
        detailsSubmitted: !!acct?.details_submitted,
        connectedAt: new Date(),
        disconnectedAt: null,
        connectedByName: payload.by ?? null,
      },
    });
    this.logger.log(
      `Tenant ${tenant.slug} connected Stripe account ${accountId} (livemode=${row.livemode}, chargesEnabled=${row.chargesEnabled})`,
    );
    return { tenantSlug: tenant.slug, accountId, chargesEnabled: row.chargesEnabled };
  }

  /** Sever the link. Deauthorize is best-effort — the row flip is what gates the UI. */
  async disconnect(tenantId: string) {
    const row = await this.prisma.tenantStripeConnect.findUnique({ where: { tenantId } });
    if (!row || row.disconnectedAt) return { disconnected: true };
    try {
      await this.stripe.client.oauth.deauthorize({
        client_id: this.clientId,
        stripe_user_id: row.stripeAccountId,
      });
    } catch (err: any) {
      this.logger.warn(`Stripe deauthorize failed for ${row.stripeAccountId}: ${err?.message}`);
    }
    await this.prisma.tenantStripeConnect.update({
      where: { tenantId },
      data: { disconnectedAt: new Date(), chargesEnabled: false },
    });
    return { disconnected: true };
  }

  /**
   * The connected, charge-ready account for a tenant — the gate in front of
   * every buyer card action. Returns null rather than throwing so read paths
   * can render "card unavailable" instead of erroring.
   */
  async chargeableAccount(tenantId: string): Promise<string | null> {
    if (!this.stripe.isConfigured) return null;
    const row = await this.prisma.tenantStripeConnect.findUnique({ where: { tenantId } });
    if (!row || row.disconnectedAt || !row.chargesEnabled) return null;
    return row.stripeAccountId;
  }

  /** account.updated webhook: sync capability flags onto every row for that account. */
  async syncAccountStatus(account: any) {
    if (!account?.id) return;
    await this.prisma.tenantStripeConnect.updateMany({
      where: { stripeAccountId: account.id, disconnectedAt: null },
      data: {
        chargesEnabled: !!account.charges_enabled,
        detailsSubmitted: !!account.details_submitted,
      },
    });
  }
}
