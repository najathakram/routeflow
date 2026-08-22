/**
 * Unit tests for StripeConnectOAuthProvider — the only file in stripe-connect
 * allowed to touch the Stripe SDK or a snake_case Stripe field. Every Stripe
 * call is mocked at `(provider as any).stripe`; nothing here hits the network.
 *
 * Covers the normalization the rest of the module now relies on:
 * `stripe_user_id`/`livemode` → `accountRef`/`livemode`,
 * `charges_enabled`/`details_submitted` → camelCase booleans, and the
 * snake_case argument shape deauthorize must still send to Stripe.
 */

import { ConfigService } from "@nestjs/config";
import { StripeConnectOAuthProvider } from "./stripe-connect-oauth.provider";
import { AppConfig } from "../../config/configuration";

function buildProvider() {
  const config = {
    get: () => ({
      secretKey: "sk_test_123",
      webhookSecret: "whsec_billing",
      priceStarter: "",
      priceProfessional: "",
      priceEnterprise: "",
      connectClientId: "ca_123",
      connectWebhookSecret: "whsec_connect_test",
    }),
  } as unknown as ConfigService<AppConfig>;

  const provider = new StripeConnectOAuthProvider(config);

  const stripe = {
    oauth: { token: jest.fn(), deauthorize: jest.fn() },
    accounts: { retrieve: jest.fn() },
  };
  (provider as any).stripe = stripe;

  return { provider, stripe };
}

describe("StripeConnectOAuthProvider", () => {
  it("normalizes the code exchange off stripe_user_id / livemode", async () => {
    const { provider, stripe } = buildProvider();
    stripe.oauth.token.mockResolvedValue({ stripe_user_id: "acct_1", livemode: true });

    await expect(provider.exchangeCode("code-1")).resolves.toEqual({
      accountRef: "acct_1",
      livemode: true,
    });
    expect(stripe.oauth.token).toHaveBeenCalledWith({
      grant_type: "authorization_code",
      code: "code-1",
    });
  });

  it("reports a missing stripe_user_id as a null accountRef, not an exception", async () => {
    const { provider, stripe } = buildProvider();
    stripe.oauth.token.mockResolvedValue({});

    await expect(provider.exchangeCode("code-1")).resolves.toEqual({
      accountRef: null,
      livemode: false,
    });
  });

  it("normalizes the account capability flags off charges_enabled / details_submitted", async () => {
    const { provider, stripe } = buildProvider();
    stripe.accounts.retrieve.mockResolvedValue({ charges_enabled: true, details_submitted: false });

    await expect(provider.retrieveAccount("acct_1")).resolves.toEqual({
      chargesEnabled: true,
      detailsSubmitted: false,
    });
  });

  it("sends deauthorize in Stripe's snake_case shape", async () => {
    const { provider, stripe } = buildProvider();
    stripe.oauth.deauthorize.mockResolvedValue({});

    await provider.deauthorize("ca_123", "acct_1");
    expect(stripe.oauth.deauthorize).toHaveBeenCalledWith({
      client_id: "ca_123",
      stripe_user_id: "acct_1",
    });
  });

  it("is not configured — and refuses to call Stripe — without a secret key", async () => {
    const config = {
      get: () => ({ secretKey: "" }),
    } as unknown as ConfigService<AppConfig>;
    const provider = new StripeConnectOAuthProvider(config);

    expect(provider.isConfigured).toBe(false);
    await expect(provider.exchangeCode("code-1")).rejects.toThrow(/not configured/i);
  });
});
