import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../config/configuration";
import {
  ConnectAccountSnapshot,
  ConnectOAuthProvider,
  ConnectOAuthToken,
} from "./connect-oauth.interface";

// Stripe v22 CJS `export =` isn't compatible with `module: "nodenext"` named
// imports, so we use require() for the constructor value (mirrors
// payment-requests/provider/stripe-payment-provider.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require("stripe");

/**
 * The ONLY file in the stripe-connect module that imports the Stripe SDK or
 * reads a snake_case Stripe field (`stripe_user_id`, `charges_enabled`,
 * `details_submitted`, `client_id`) — `StripeConnectService` speaks the
 * normalized shapes from `connect-oauth.interface.ts` instead (invariant 4).
 *
 * Builds its own Stripe client from env (`STRIPE_SECRET_KEY`), deliberately
 * independent of the SaaS billing module's `StripeService` for the same reason
 * `StripePaymentProvider` is: buyer Connect linking and platform billing must
 * stay decoupled failure domains, so a key rotation, SDK bump or outage-driven
 * change on the billing side cannot ripple into a tenant linking their
 * account. The platform key itself is shared — only the wrapper is not.
 */
@Injectable()
export class StripeConnectOAuthProvider implements ConnectOAuthProvider {
  private readonly logger = new Logger(StripeConnectOAuthProvider.name);
  private readonly stripe: any;

  constructor(config: ConfigService<AppConfig>) {
    const secretKey = config.get<AppConfig["stripe"]>("stripe")?.secretKey ?? "";
    this.stripe = secretKey ? new Stripe(secretKey) : null;
    if (!secretKey) {
      this.logger.warn("STRIPE_SECRET_KEY not set — Stripe Connect linking disabled.");
    }
  }

  get isConfigured(): boolean {
    return this.stripe !== null;
  }

  private get client(): any {
    if (!this.stripe) {
      throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY to enable Connect.");
    }
    return this.stripe;
  }

  async exchangeCode(code: string): Promise<ConnectOAuthToken> {
    const token = await this.client.oauth.token({ grant_type: "authorization_code", code });
    return { accountRef: token?.stripe_user_id ?? null, livemode: !!token?.livemode };
  }

  async retrieveAccount(accountRef: string): Promise<ConnectAccountSnapshot> {
    const acct = await this.client.accounts.retrieve(accountRef);
    return {
      chargesEnabled: !!acct?.charges_enabled,
      detailsSubmitted: !!acct?.details_submitted,
    };
  }

  async deauthorize(clientId: string, accountRef: string): Promise<void> {
    await this.client.oauth.deauthorize({ client_id: clientId, stripe_user_id: accountRef });
  }
}
