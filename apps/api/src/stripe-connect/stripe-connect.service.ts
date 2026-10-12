import { randomUUID } from "crypto";
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { acceptsAutomatedWrites } from "../tenant/tenant-automation";
import {
  CONNECT_OAUTH_PROVIDER,
  type ConnectAccountSnapshot,
  type ConnectOAuthProvider,
  type ConnectOAuthToken,
} from "./provider/connect-oauth.interface";
import { AppConfig } from "../config/configuration";
import {
  DERIVED_JWT_AUDIENCES,
  DERIVED_JWT_LABELS,
  derivedJwtKey,
} from "../common/derived-jwt-key";

/**
 * Stripe Connect (Standard accounts, direct charges, no platform fee).
 *
 * A tenant links the Stripe account they already own through the Connect OAuth
 * flow; buyer card payments are then created ON that account (`stripeAccount`
 * option per call), so the funds, the Stripe customer and the dispute all live
 * with the tenant. RouteFlow's platform key only brokers the OAuth exchange and
 * reads account status, and it does so behind this module's own
 * `CONNECT_OAUTH_PROVIDER` port (invariant 4): no Stripe SDK call and no
 * snake_case Stripe field appears in this file, and nothing here reaches for
 * the SaaS billing module's `StripeService`, so a billing-side key rotation,
 * SDK bump or outage-driven change can no longer ripple into buyer Connect
 * linking. That port is separate from payment-requests' `PAYMENT_PROVIDER`
 * because these calls go to Stripe's OAuth endpoints with the PLATFORM key,
 * not to a connected account.
 *
 * The OAuth `state` is a short-lived, single-use JWT naming the tenant, signed
 * with the app's own secret — the callback trusts it and NOTHING else.
 * Without tenant-binding, a crafted callback URL could bind one tenant's
 * Stripe account to another tenant (the callback is necessarily public:
 * Stripe redirects the browser to it without our auth headers). Without
 * single-use enforcement (invariant 12), a leaked/replayed callback URL could
 * be exchanged a second time within the 15-minute window — `pendingJti` +
 * `pendingJtiIssuedAt` on the row close that: `buildAuthorizeUrl` stashes a
 * fresh jti BEFORE redirecting, `completeOAuth` consumes it atomically, and a
 * second exchange of the same `state` finds nothing to consume.
 *
 * ANTI-SPOOF (invariant 2): `assertEventAccount` is the single cross-check
 * every webhook-driven write (here and in PaymentRequestsService) must pass
 * before touching state or money — it requires that the event's `accountRef`
 * actually matches the connected, non-disconnected account on file for the
 * tenant the event's metadata resolved to.
 */
@Injectable()
export class StripeConnectService {
  private readonly logger = new Logger(StripeConnectService.name);
  private readonly stateKey: Buffer;

  /**
   * The platform's own Stripe account id, cached after the first successful
   * `retrievePlatformAccountId()` call — it never changes for a running
   * process, and `completeOAuth` needs it on every callback (B2441).
   */
  private platformAccountId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONNECT_OAUTH_PROVIDER) private readonly oauth: ConnectOAuthProvider,
    private readonly config: ConfigService<AppConfig>,
    private readonly jwt: JwtService,
  ) {
    // Fails the boot on a missing or short secret (see derived-jwt-key.ts).
    this.stateKey = derivedJwtKey(
      DERIVED_JWT_LABELS.stripeConnectState,
      config.get<AppConfig["jwt"]>("jwt")?.secret ?? "",
    );
  }

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
    return this.oauth.isConfigured && this.clientId.length > 0;
  }

  /**
   * Current link status for the settings card. Never throws on "not
   * connected". A row can exist with `stripeAccountId: null` (a link was
   * started via `buildAuthorizeUrl` but the callback never completed) — that
   * is NOT "connected".
   */
  async getStatus(tenantId: string) {
    const row = await this.prisma.tenantStripeConnect.findUnique({ where: { tenantId } });
    const connected = !!row && !!row.stripeAccountId && !row.disconnectedAt;
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

  /**
   * Build the Stripe OAuth authorize URL, carrying a signed, single-use,
   * tenant-bound state. The jti is persisted BEFORE the redirect so
   * `completeOAuth` can enforce single-use even on the very first link
   * attempt (invariant 12) — a row may not exist yet for a first-time
   * connect, so this upserts a "link started" shell; `stripeAccountId` stays
   * null until the callback actually completes, and a later relink only
   * touches the pending-jti pair, never clobbering an existing connection.
   *
   * REG-2441: Stripe otherwise pre-selects whichever Stripe account is
   * already signed in on the operator's browser — on the owner's own browser
   * that is RouteFlow's platform account, so a tenant could end up
   * "connected" to the platform's account instead of their own. The actual
   * guard against that is the refusal in `completeOAuth` below — these URL
   * params are NOT the guard, just a best-effort nudge that reduces the
   * chance of picking the wrong account in the first place: `stripe_landing=
   * register` + `always_prompt=true` push Stripe toward its own account
   * picker instead of an auto-selected session, and prefilling
   * `stripe_user[email]`/`stripe_user[business_name]` steers a fresh sign-in
   * toward the tenant's business rather than leaving the fields blank.
   * Prefill is best-effort: an empty value is omitted rather than sent as
   * `stripe_user[email]=`.
   */
  async buildAuthorizeUrl(
    tenantId: string,
    startedByUserId?: string | null,
    startedByName?: string | null,
  ): Promise<string> {
    if (!this.isConfigured) {
      throw new BadRequestException(
        "Stripe Connect is not configured on this platform yet (STRIPE_SECRET_KEY / STRIPE_CONNECT_CLIENT_ID).",
      );
    }
    const jti = randomUUID();
    const state = await this.jwt.signAsync(
      { purpose: "stripe-connect", tid: tenantId, by: startedByName ?? null, jti },
      {
        secret: this.stateKey,
        audience: DERIVED_JWT_AUDIENCES.stripeConnectState,
        expiresIn: "15m",
      },
    );
    await this.prisma.tenantStripeConnect.upsert({
      where: { tenantId },
      create: { tenantId, pendingJti: jti, pendingJtiIssuedAt: new Date() },
      update: { pendingJti: jti, pendingJtiIssuedAt: new Date() },
    });

    // PREFILL-EMAIL RULING (SA-458, supersedes the earlier "requester
    // first"): the prefilled email becomes the login for the Stripe account
    // that gets created/signed into, and that account belongs to the
    // BUSINESS, not to whichever staff member happened to click the button.
    // Order: (1) the requester's own email, but ONLY when the requester is a
    // TENANT_ADMIN — the role that actually owns the business's Stripe
    // account; (2) else the tenant's oldest non-deleted TENANT_ADMIN, so a
    // non-admin requester (e.g. OPERATOR) still steers Stripe toward the
    // account's rightful owner instead of a line staffer's inbox; (3) else
    // the requester's own email regardless of role, when the tenant has no
    // TENANT_ADMIN at all — some prefill beats none; (4) else omitted.
    const [requester, tenant] = await Promise.all([
      // Tenant-scoped on purpose: a requester id that belongs to a different
      // tenant (stale/forged) must never leak that other tenant's email into
      // this authorize URL — findFirst with both id AND tenantId yields
      // nothing in that case, so a cross-tenant id is ignored entirely.
      startedByUserId
        ? this.prisma.user.findFirst({
            where: { id: startedByUserId, tenantId, deletedAt: null },
            select: { email: true, role: true },
          })
        : Promise.resolve(null),
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    ]);
    let adminEmail = requester?.role === UserRole.TENANT_ADMIN ? requester.email : null;
    if (!adminEmail) {
      const fallbackAdmin = await this.prisma.user.findFirst({
        where: { tenantId, role: UserRole.TENANT_ADMIN, deletedAt: null },
        orderBy: { createdAt: "asc" },
        select: { email: true },
      });
      adminEmail = fallbackAdmin?.email || requester?.email || null;
    }
    const businessName = tenant?.name || null;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      scope: "read_write",
      redirect_uri: this.redirectUri,
      state,
      stripe_landing: "register",
      always_prompt: "true",
    });
    if (adminEmail) params.set("stripe_user[email]", adminEmail);
    if (businessName) params.set("stripe_user[business_name]", businessName);
    return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * OAuth callback: verify the state, consume its single-use jti, exchange
   * the code, store the account. Every failure throws a `BadRequestException`
   * whose message is one of a FIXED set of internal codes (never a raw
   * exception string) — `StripeConnectCallbackController` maps each to a
   * user-safe sentence, so the public callback can never leak internal
   * exception text (invariant 12).
   */
  async completeOAuth(code: string, state: string) {
    let payload: {
      purpose?: string;
      tid?: string;
      by?: string | null;
      jti?: string;
      aud?: unknown;
    };
    try {
      payload = await this.jwt.verifyAsync(state, { secret: this.stateKey });
    } catch {
      throw new BadRequestException("state_expired");
    }
    if (
      payload.aud !== DERIVED_JWT_AUDIENCES.stripeConnectState ||
      payload.purpose !== "stripe-connect" ||
      !payload.tid ||
      !payload.jti
    ) {
      throw new BadRequestException("state_invalid");
    }
    const tenantId = payload.tid;

    // Single-use (invariant 12): atomically consume the pending jti. A
    // second exchange of the same state token — a leaked or replayed
    // callback URL — finds no matching pendingJti (already cleared by the
    // first exchange, or never set) and is rejected outright.
    const consumed = await this.prisma.tenantStripeConnect.updateMany({
      where: { tenantId, pendingJti: payload.jti },
      data: { pendingJti: null, pendingJtiIssuedAt: null },
    });
    if (consumed.count === 0) {
      throw new BadRequestException("state_replayed");
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, status: true },
    });
    if (!tenant) throw new BadRequestException("tenant_not_found");

    // The signed state was minted while the workspace accepted changes; its status may
    // have moved since. Re-read it live and refuse BEFORE the code exchange, so a
    // workspace that no longer accepts changes never gets a Stripe grant or a bound
    // payout account. Same TRIAL/ACTIVE rule as every other system-side write.
    if (!acceptsAutomatedWrites(tenant.status)) {
      throw new BadRequestException("workspace_read_only");
    }

    // REG-2441: resolve the PLATFORM's own account id BEFORE exchanging the
    // code — a code exchange creates a live Stripe OAuth grant, so doing the
    // exchange first and only then discovering we can't even check for a
    // self-connect would leave a live, unrecorded connection dangling on
    // Stripe's side with nothing to show for it here. Fail closed if the
    // platform-id check itself can't be made — never proceed to exchange
    // (and never store) without it. Cached after the first successful read
    // since the platform's own account id never changes per process; an
    // empty/missing id is never cached or trusted, even if a provider
    // implementation ever resolves "" instead of throwing.
    let platformAccountId: string;
    try {
      platformAccountId = this.platformAccountId ?? (await this.oauth.retrievePlatformAccountId());
      if (!platformAccountId) {
        throw new Error("Platform account id was empty.");
      }
    } catch (err: any) {
      this.logger.warn(`Platform account check failed for ${tenant.slug}: ${err?.message}`);
      throw new BadRequestException("platform_account_check_failed");
    }
    this.platformAccountId = platformAccountId;

    let token: ConnectOAuthToken;
    try {
      token = await this.oauth.exchangeCode(code);
    } catch (err: any) {
      this.logger.warn(`Connect OAuth exchange failed for ${tenant.slug}: ${err?.message}`);
      throw new BadRequestException("stripe_exchange_failed");
    }
    const accountId = token.accountRef;
    if (!accountId) throw new BadRequestException("account_missing");

    // The id COMPARISON stays here, after the exchange — it's the exchanged
    // account we're checking, so this can only run once we have it.
    if (accountId === platformAccountId) {
      this.logger.warn(
        `Tenant ${tenant.slug} attempted to connect the platform's own Stripe account ` +
          `(${accountId}) — refused, nothing stored.`,
      );
      throw new BadRequestException("platform_account_not_allowed");
    }

    // Account status now, so chargesEnabled is correct before the first
    // account.updated webhook arrives.
    let acct: ConnectAccountSnapshot | null = null;
    try {
      acct = await this.oauth.retrieveAccount(accountId);
    } catch (err: any) {
      this.logger.warn(`Stripe account read for ${accountId} failed: ${err?.message}`);
    }

    const row = await this.prisma.tenantStripeConnect.upsert({
      where: { tenantId },
      create: {
        tenantId,
        stripeAccountId: accountId,
        livemode: token.livemode,
        chargesEnabled: acct?.chargesEnabled ?? false,
        detailsSubmitted: acct?.detailsSubmitted ?? false,
        connectedByName: payload.by ?? null,
      },
      update: {
        stripeAccountId: accountId,
        livemode: token.livemode,
        chargesEnabled: acct?.chargesEnabled ?? false,
        detailsSubmitted: acct?.detailsSubmitted ?? false,
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
    if (row.stripeAccountId) {
      try {
        await this.oauth.deauthorize(this.clientId, row.stripeAccountId);
      } catch (err: any) {
        this.logger.warn(`Stripe deauthorize failed for ${row.stripeAccountId}: ${err?.message}`);
      }
    }
    await this.prisma.tenantStripeConnect.update({
      where: { tenantId },
      data: {
        disconnectedAt: new Date(),
        chargesEnabled: false,
        pendingJti: null,
        pendingJtiIssuedAt: null,
      },
    });
    return { disconnected: true };
  }

  /**
   * The connected, charge-ready account for a tenant — the gate in front of
   * every buyer card action. Returns null rather than throwing so read paths
   * can render "card unavailable" instead of erroring — callers
   * (`PaymentRequestsService.paymentContext` sets `cardEnabled: !!account`;
   * `createBuyerPaymentRequest` throws a user-safe "does not accept card
   * payments yet" on null) already treat null as "cards temporarily
   * unavailable", so failing closed here degrades gracefully rather than
   * breaking anything.
   *
   * REG-2441: also refuses the PLATFORM's own account id, the same guard as
   * `completeOAuth` — a row can only carry that id if it slipped in before
   * this guard existed. FAILS CLOSED on the platform-id check itself: a
   * lookup that throws, or resolves empty, returns null rather than the
   * stored account, using (and refreshing) the same in-memory cache
   * `completeOAuth` populates.
   */
  async chargeableAccount(tenantId: string): Promise<string | null> {
    if (!this.oauth.isConfigured) return null;
    const row = await this.prisma.tenantStripeConnect.findUnique({ where: { tenantId } });
    if (!row || row.disconnectedAt || !row.chargesEnabled) return null;

    let platformAccountId: string;
    try {
      platformAccountId = this.platformAccountId ?? (await this.oauth.retrievePlatformAccountId());
      if (!platformAccountId) {
        throw new Error("Platform account id was empty.");
      }
    } catch (err: any) {
      this.logger.warn(
        `Platform account check failed for tenant ${tenantId}: ${err?.message} — refusing to charge.`,
      );
      return null;
    }
    this.platformAccountId = platformAccountId;

    if (row.stripeAccountId === platformAccountId) return null;
    return row.stripeAccountId;
  }

  /**
   * The Stripe account id last stored for a tenant, EVEN IF the link has since
   * been disconnected or deauthorized. `getStatus` and `chargeableAccount`
   * both deliberately report null once `disconnectedAt` is set, which is right
   * for anything that would create a new charge — but a Checkout session
   * created while the link was live still exists on that account and can still
   * be paid. `cancelOwn` needs it (invariant 6: always attempt the expire), or
   * a seller disconnecting Stripe would permanently lock the buyer out — every
   * cancel refused for want of an account, and the open-request index blocking
   * any new request until the 24h expiry webhook finally fires.
   */
  async lastKnownAccount(tenantId: string): Promise<string | null> {
    const row = await this.prisma.tenantStripeConnect.findUnique({
      where: { tenantId },
      select: { stripeAccountId: true },
    });
    return row?.stripeAccountId ?? null;
  }

  /**
   * Anti-spoof gate (invariant 2). Every webhook-driven state/money write
   * that resolves its tenant from event metadata (rather than from a
   * tenant-owned row looked up BY accountRef, e.g. `account.updated`) must
   * call this BEFORE touching anything else: it requires that the event's
   * `accountRef` is exactly the account on file for that tenant, and that
   * the link is not disconnected. A mismatch is logged CRITICAL and nothing
   * is written — the caller acks the webhook and moves on.
   */
  async assertEventAccount(tenantId: string, accountRef: string): Promise<boolean> {
    const row = await this.prisma.tenantStripeConnect.findUnique({ where: { tenantId } });
    const ok = !!row && !row.disconnectedAt && row.stripeAccountId === accountRef;
    if (!ok) {
      this.logger.error(
        `CRITICAL: Connect webhook account mismatch — tenant ${tenantId} expected account ` +
          `${row?.stripeAccountId ?? "(no connected row)"} but the event carried ${accountRef}. Nothing written.`,
      );
    }
    return ok;
  }

  /**
   * Invariant 2's NON-metadata resolution path: the tenant(s) linked to a
   * connected account. Some Connect events carry no usable metadata to
   * resolve a tenant from — a `charge.dispute.created` event object is a
   * Dispute, whose `metadata` is its own (empty unless set through the
   * Disputes API) and is NOT inherited from the Charge or PaymentIntent — so
   * `event.account` is the only truthful attribution available. As with
   * `markDeauthorized`, the accountRef IS the resolution here, which is
   * exactly why no `assertEventAccount` cross-check applies: it would be
   * circular. `findMany` on purpose — one business may run two tenants off
   * one Stripe account.
   */
  async tenantsForAccount(accountRef: string): Promise<string[]> {
    if (!accountRef) return [];
    const rows = await this.prisma.tenantStripeConnect.findMany({
      where: { stripeAccountId: accountRef, disconnectedAt: null },
      select: { tenantId: true },
    });
    return rows.map((r) => r.tenantId);
  }

  /**
   * account.updated webhook: the invariant 3 ordering guard and the
   * capability sync in one call. Applies the (already-normalized —
   * invariant 4, no snake_case Stripe field reaches this file) flags only if
   * `eventCreatedAt` is strictly newer than the last account.updated
   * delivery already applied for this account (queried off the
   * StripeConnectEvent ledger) — a stale, out-of-order redelivery can no
   * longer disable (or re-enable) a live tenant's payments. Returns whether
   * it actually applied, so the caller can record the ledger outcome.
   * `updateMany` (not `update`) on purpose — one business may run two
   * tenants off one Stripe account.
   */
  async applyAccountUpdate(accountRef: string): Promise<boolean> {
    if (!accountRef) return false;
    // The event is a TRIGGER, never a data source. Stripe delivers
    // account.updated out of order and retries failed deliveries for days —
    // during the #400 rawBody outage a Restricted-era retry backlog built up,
    // and one stale snapshot disabled card payments for a fully-live account
    // (2026-08-22 incident). Ledger-ordering guards can't close that hole
    // either (a cold-start ledger has no baseline), so the only robust
    // pattern is Stripe's own recommendation: retrieve the account's CURRENT
    // state and persist that. Idempotent and order-proof by construction.
    // A retrieve failure throws — the controller 500s and Stripe redelivers.
    const snapshot = await this.oauth.retrieveAccount(accountRef);
    await this.prisma.tenantStripeConnect.updateMany({
      where: { stripeAccountId: accountRef, disconnectedAt: null },
      data: {
        chargesEnabled: snapshot.chargesEnabled,
        detailsSubmitted: snapshot.detailsSubmitted,
      },
    });
    return true;
  }

  /**
   * account.application.deauthorized: the connected account owner revoked
   * our platform's access. Severs every tenant row on that account (mirrors
   * `applyAccountUpdate`'s one-account-many-tenants note) and returns the
   * affected tenant ids so the caller can notify each of them.
   */
  async markDeauthorized(accountRef: string): Promise<string[]> {
    if (!accountRef) return [];
    const rows = await this.prisma.tenantStripeConnect.findMany({
      where: { stripeAccountId: accountRef, disconnectedAt: null },
      select: { tenantId: true },
    });
    if (rows.length === 0) return [];
    await this.prisma.tenantStripeConnect.updateMany({
      where: { stripeAccountId: accountRef, disconnectedAt: null },
      data: { disconnectedAt: new Date(), chargesEnabled: false },
    });
    return rows.map((r) => r.tenantId);
  }
}
