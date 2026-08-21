/**
 * Port for the Connect OAuth link — code exchange, account read, deauthorize.
 * This is the ONLY thing `StripeConnectService` may depend on for Stripe
 * behavior: every Stripe SDK call and every snake_case Stripe field in this
 * module lives behind the single adapter that implements it
 * (`stripe-connect-oauth.provider.ts`), mirroring payment-requests'
 * `PAYMENT_PROVIDER`. Domain code speaks these normalized, camelCase shapes
 * only (invariant 4).
 *
 * A SEPARATE port from `PAYMENT_PROVIDER` on purpose: these three calls are
 * made with the PLATFORM key against Stripe's OAuth endpoints — not on a
 * connected account — so payment-requests must never gain a route to them,
 * and linking must not break because a checkout-side change touched a shared
 * wrapper.
 *
 * DI: there is no concrete class to depend on directly — inject with
 * `@Inject(CONNECT_OAUTH_PROVIDER)` against the `ConnectOAuthProvider` type,
 * so tests can substitute a fake without touching the network or the SDK.
 */
export const CONNECT_OAUTH_PROVIDER = Symbol("ConnectOAuthProvider");

/** The OAuth code exchange result, normalized off Stripe's snake_case shape. */
export interface ConnectOAuthToken {
  /** Stripe's `stripe_user_id` — the connected account id; null when absent. */
  accountRef: string | null;
  livemode: boolean;
}

/** A connected account's capability flags, normalized. */
export interface ConnectAccountSnapshot {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface ConnectOAuthProvider {
  /** True when the platform Stripe key is set — nothing can link without it. */
  readonly isConfigured: boolean;

  /**
   * Exchanges an authorization code for the tenant's account id. Throws on a
   * Stripe failure: `completeOAuth` maps that to one of its fixed internal
   * codes rather than letting exception text reach the public callback.
   */
  exchangeCode(code: string): Promise<ConnectOAuthToken>;

  /**
   * Current capability flags for a connected account, so `chargesEnabled` is
   * right before the first `account.updated` webhook arrives. Throws if the
   * read fails — the caller treats that as "not known yet", never as fatal.
   */
  retrieveAccount(accountRef: string): Promise<ConnectAccountSnapshot>;

  /** Revokes the platform's access to a connected account. Throws on failure. */
  deauthorize(clientId: string, accountRef: string): Promise<void>;
}
