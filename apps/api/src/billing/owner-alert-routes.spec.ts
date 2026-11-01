/**
 * W1 (COPY 2q, PLAN F24f): every tenant billing route that changes what an account owes either tells the owner about a
 * no-card account or says why it need not. A new `@NoImpersonation("billing")` route fails here until it is listed, so a
 * plan change that nobody bills cannot be added silently.
 *
 * The mail itself is sent by `SubscriptionMutationService`, AFTER each change commits and from the row it read first
 * (rows F24, F24b-h are driven on Postgres in `owner-alert-plan-change.db.spec.ts`). This file pins what a unit lane can:
 *   - the route inventory, and that each alerting route calls the method that sends its own kind;
 *   - the controller sends nothing itself (the old wrapper judged the route's outcome, not the commit);
 *   - the wiring: all the `ownerAlerts` consumers are `@Optional()`, so a module slip would go SILENT. The Nest module
 *     metadata and the constructor tokens must stay what makes the real graph supply `OwnerAlertService` to every one of them.
 */
import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { NO_IMPERSONATION_KEY } from "../auth/guards/no-impersonation.guard";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { EmailModule } from "../email/email.module";
import { OwnerAlertService } from "../email/owner-alert.service";
import { FirstRunService } from "../settings-fulfilment/first-run.service";
import { SettingsFulfilmentModule } from "../settings-fulfilment/settings-fulfilment.module";
import { TenantsModule } from "../tenants/tenants.module";
import { TenantsService } from "../tenants/tenants.service";
import { BillingModule } from "./billing.module";
import { SettingsBillingController } from "./settings-billing.controller";
import { SubscriptionMutationService } from "./subscription-mutation.service";

/** controller route -> the mutation method it calls, the method that holds its body, and the kind it mails. */
const ALERTING = {
  subscribe: { method: "subscribe", body: "subscribe", kind: "subscribe" },
  upgrade: { method: "upgrade", body: "upgradeLocked", kind: "upgrade" },
  downgrade: { method: "downgrade", body: "downgrade", kind: "downgrade" },
  cancel: { method: "cancel", body: "cancel", kind: "cancel" },
  resume: { method: "resume", body: "resume", kind: "resume" },
} as const;

/** Routes that move no plan: a hosted page, or a priced add-on on a card the owner never sees. */
const EXEMPT: Record<string, string> = {
  createCheckout: "opens Stripe Checkout; the card is taken there and Stripe bills it",
  createPortal: "opens the Stripe portal; an account with no Stripe customer cannot",
  enableAddon: "add-ons are priced through the plan's own billing path, with the add-on ledger",
  disableAddon: "add-ons are priced through the plan's own billing path, with the add-on ledger",
};

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, ...p), "utf8");

/** The text of `async name(` up to the closing brace at the method's own indent. */
function methodBody(src: string, name: string): string {
  const start = src.search(new RegExp(`\\n  (private )?async ${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The text of a controller method named `name`, from its signature to the next 2-space closing brace. */
function controllerRoute(src: string, name: string): string {
  const start = src.search(new RegExp(`\\n  ${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n  }\n", start));
}

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

  describe("the mail is sent by the mutation service, after the commit", () => {
    const controller = read("settings-billing.controller.ts");
    const service = read("subscription-mutation.service.ts");

    it("the controller sends no alert of its own (it cannot see whether the change committed)", () => {
      expect(controller).not.toMatch(
        /ownerAlerts|OwnerAlertService|planChangeNoCard|alertIfNoCard/,
      );
    });

    it.each(Object.entries(ALERTING))(
      "%s calls the mutation method that mails its own kind, once, after its write",
      (route, { method, body, kind }) => {
        expect(controllerRoute(controller, route)).toMatch(
          new RegExp(`this\\.mutations\\.${method}\\(`),
        );
        const text = methodBody(service, body);
        const calls = text.match(/this\.alertNoCard\(/g) ?? [];
        expect(calls).toHaveLength(1);
        expect(text).toContain(`this.alertNoCard(tenantId, "${kind}")`);
        // After the transaction that wrote the change, never before it.
        expect(text.indexOf("this.alertNoCard(")).toBeGreaterThan(text.indexOf("$transaction("));
      },
    );

    it("cancel: only an ACTIVE account's first cancel mails (a trial and a read-only no-op return earlier)", () => {
      expect(methodBody(service, "cancel")).toMatch(
        /if \(tenant\?\.status === "ACTIVE" && !sub\.cancelAtPeriodEnd\) \{\s*await this\.alertNoCard\(tenantId, "cancel"\)/,
      );
    });

    it("resume mails only when something was armed; downgrade only for a different target", () => {
      expect(methodBody(service, "resume")).toMatch(
        /if \(sub\.cancelAtPeriodEnd \|\| sub\.downgradeToPlanKey\) await this\.alertNoCard\(tenantId, "resume"\)/,
      );
      expect(methodBody(service, "downgrade")).toMatch(
        /if \(sub\.downgradeToPlanKey !== targetPlanKey\) await this\.alertNoCard\(tenantId, "downgrade"\)/,
      );
    });
  });

  describe("wiring: an @Optional() consumer must not go silent", () => {
    const resolve = (i: any) => (i && typeof i === "object" && i.forwardRef ? i.forwardRef() : i);
    const importsOf = (m: unknown) =>
      ((Reflect.getMetadata("imports", m as object) ?? []) as unknown[]).map(resolve);

    it.each([
      ["AuthModule", AuthModule],
      ["TenantsModule", TenantsModule],
      ["BillingModule", BillingModule],
      ["SettingsFulfilmentModule", SettingsFulfilmentModule],
    ])("%s imports EmailModule, which exports OwnerAlertService", (_n, mod) => {
      expect(importsOf(mod)).toContain(EmailModule);
    });

    it("EmailModule provides and exports OwnerAlertService", () => {
      expect(Reflect.getMetadata("providers", EmailModule)).toContain(OwnerAlertService);
      expect(Reflect.getMetadata("exports", EmailModule)).toContain(OwnerAlertService);
    });

    it.each([
      ["SubscriptionMutationService", SubscriptionMutationService],
      ["AuthService", AuthService],
      ["TenantsService", TenantsService],
      ["FirstRunService", FirstRunService],
    ])("%s asks Nest for the OwnerAlertService class itself", (_n, cls) => {
      const tokens = (Reflect.getMetadata("design:paramtypes", cls) ?? []) as unknown[];
      expect(tokens).toContain(OwnerAlertService);
    });
  });
});
