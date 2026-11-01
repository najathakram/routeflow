/**
 * W1 (COPY 2q): every tenant billing route that changes what an account owes either tells the owner about a no-card account
 * or says why it need not. A new `@NoImpersonation("billing")` route fails here until it is listed, so a plan change that
 * nobody bills cannot be added silently. The five plan routes are also driven: the alert fires AFTER the change commits,
 * never when it is refused, and a failing alert never fails the change.
 */
import "reflect-metadata";
import { NO_IMPERSONATION_KEY } from "../auth/guards/no-impersonation.guard";
import { SettingsBillingController } from "./settings-billing.controller";

const ALERTING = {
  subscribe: "subscribe",
  upgrade: "upgrade",
  downgrade: "downgrade",
  cancel: "cancel",
  resume: "resume",
} as const;

/** Routes that move no plan: a hosted page, or a priced add-on on a card the owner never sees. */
const EXEMPT: Record<string, string> = {
  createCheckout: "opens Stripe Checkout; the card is taken there and Stripe bills it",
  createPortal: "opens the Stripe portal; an account with no Stripe customer cannot",
  enableAddon: "add-ons are priced through the plan's own billing path, with the add-on ledger",
  disableAddon: "add-ons are priced through the plan's own billing path, with the add-on ledger",
};

const billingRoutes = Object.getOwnPropertyNames(SettingsBillingController.prototype).filter(
  (name) =>
    name !== "constructor" &&
    Reflect.getMetadata(
      NO_IMPERSONATION_KEY,
      (SettingsBillingController.prototype as any)[name],
    ) === "billing",
);

describe("owner alerts on tenant billing routes", () => {
  it("lists every @NoImpersonation('billing') route as alerting or exempt, and nothing stale", () => {
    const known = [...Object.keys(ALERTING), ...Object.keys(EXEMPT)].sort();
    expect([...billingRoutes].sort()).toEqual(known);
  });

  const user = { tenantId: "t-1", sub: "u-1" };
  function make(mutation: jest.Mock, alert: jest.Mock) {
    const mutations = {
      subscribe: mutation,
      upgrade: mutation,
      downgrade: mutation,
      cancel: mutation,
      resume: mutation,
    };
    return new SettingsBillingController(
      {} as never,
      {} as never,
      mutations as never,
      {} as never,
      { planChangeNoCard: alert } as never,
    );
  }
  const call = (c: SettingsBillingController, route: keyof typeof ALERTING) =>
    (c as any)[route](user, { planKey: "TEAM", cycle: "MONTHLY", targetPlanKey: "STARTER" });

  it.each(Object.entries(ALERTING))(
    "%s alerts after it commits, with its own kind",
    async (route, kind) => {
      const alert = jest.fn(async () => undefined);
      const mutation = jest.fn(async () => ({ ok: true }));
      await expect(call(make(mutation, alert), route as keyof typeof ALERTING)).resolves.toEqual({
        ok: true,
      });
      expect(alert).toHaveBeenCalledWith("t-1", kind);
      expect(mutation.mock.invocationCallOrder[0]).toBeLessThan(alert.mock.invocationCallOrder[0]);
    },
  );

  it.each(Object.keys(ALERTING))("%s refused: no alert", async (route) => {
    const alert = jest.fn();
    const mutation = jest.fn(async () => {
      throw new Error("refused");
    });
    await expect(call(make(mutation, alert), route as keyof typeof ALERTING)).rejects.toThrow(
      "refused",
    );
    expect(alert).not.toHaveBeenCalled();
  });

  it("a rejected alert never fails the change", async () => {
    const alert = jest.fn(async () => {
      throw new Error("mail down");
    });
    const c = make(
      jest.fn(async () => ({ ok: true })),
      alert,
    );
    await expect(call(c, "upgrade")).resolves.toEqual({ ok: true });
  });
});
