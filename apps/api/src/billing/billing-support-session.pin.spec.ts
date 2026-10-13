import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { Get, Patch, Post, RequestMethod, SetMetadata } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { NoImpersonation } from "../auth/decorators/no-impersonation.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { NO_IMPERSONATION_KEY, NoImpersonationGuard } from "../auth/guards/no-impersonation.guard";
import {
  StripeConnectCallbackController,
  StripeConnectController,
} from "../stripe-connect/stripe-connect.controller";
import { SettingsBillingController } from "./settings-billing.controller";

/**
 * SA-778 pin: every mutating (non-GET) handler of the tenant billing controllers carries
 * `@NoImpersonation("billing")` (the marker AND the guard), except an explicit allow-list. A new billing
 * mutation added without it fails here by name.
 */

type Ctor = (new (...args: never[]) => unknown) & { prototype: object };

/** Handlers that mutate (any verb but GET) yet lack the marker or the guard. `Class.handler` names. */
function unprotectedMutations(ctrl: Ctor, allow: readonly string[] = []): string[] {
  const proto = ctrl.prototype as Record<string, unknown>;
  const hasGuard = (guards: unknown) =>
    Array.isArray(guards) && (guards as unknown[]).includes(NoImpersonationGuard);
  const offenders: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    const fn = proto[name];
    if (name === "constructor" || typeof fn !== "function") continue;
    const verb = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
    if (verb === undefined || verb === RequestMethod.GET) continue;
    if (allow.includes(name)) continue;
    const marked =
      Reflect.getMetadata(NO_IMPERSONATION_KEY, fn) !== undefined ||
      Reflect.getMetadata(NO_IMPERSONATION_KEY, ctrl) !== undefined;
    const guarded =
      hasGuard(Reflect.getMetadata(GUARDS_METADATA, fn)) ||
      hasGuard(Reflect.getMetadata(GUARDS_METADATA, ctrl));
    if (!marked || !guarded) offenders.push(`${ctrl.name}.${name}`);
  }
  return offenders;
}

/** Mutating handler names of a controller (any verb but GET). */
function mutatingHandlers(ctrl: Ctor): string[] {
  const proto = ctrl.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter((name) => {
    const fn = proto[name];
    if (name === "constructor" || typeof fn !== "function") return false;
    const verb = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
    return verb !== undefined && verb !== RequestMethod.GET;
  });
}

/** Read-like POSTs: no state change, so a support session may call them. */
const ALLOWED = ["quote"] as const;

describe("tenant billing mutations carry @NoImpersonation (SA-778 pin)", () => {
  it("every non-GET handler of SettingsBillingController is marked and guarded, except the allow-list", () => {
    expect(unprotectedMutations(SettingsBillingController, ALLOWED)).toEqual([]);
  });

  it("the mutating handlers are exactly the ones reviewed (a new one is a conscious add)", () => {
    expect(mutatingHandlers(SettingsBillingController).sort()).toEqual(
      [
        "cancel",
        "createCheckout",
        "createPortal",
        "disableAddon",
        "downgrade",
        "enableAddon",
        "quote",
        "resume",
        "subscribe",
        "upgrade",
      ].sort(),
    );
  });

  it("every allow-list entry is still a real mutating handler (shrink-only)", () => {
    const names = mutatingHandlers(SettingsBillingController);
    for (const allowed of ALLOWED) expect(names).toContain(allowed);
  });

  it("the controller authenticates at class level, so the method-level guard runs after JwtAuthGuard", () => {
    const classGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      SettingsBillingController,
    ) as unknown[];
    expect(classGuards[0]).toBe(JwtAuthGuard);
    expect(classGuards).not.toContain(NoImpersonationGuard);
  });

  describe("payment setup (Stripe Connect)", () => {
    it("every non-GET handler of StripeConnectController is marked and guarded (no allow-list)", () => {
      expect(unprotectedMutations(StripeConnectController)).toEqual([]);
    });

    it("its mutating handlers are exactly link and disconnect", () => {
      expect(mutatingHandlers(StripeConnectController).sort()).toEqual(["disconnect", "link"]);
    });

    it("it authenticates at class level, so the method-level guard runs after JwtAuthGuard", () => {
      const classGuards = Reflect.getMetadata(
        GUARDS_METADATA,
        StripeConnectController,
      ) as unknown[];
      expect(classGuards[0]).toBe(JwtAuthGuard);
      expect(classGuards).not.toContain(NoImpersonationGuard);
    });

    it("the public OAuth return controller has no mutating route (signed state, GET only)", () => {
      expect(mutatingHandlers(StripeConnectCallbackController)).toEqual([]);
    });
  });

  describe("negative control: the detector catches what it should", () => {
    class Fake {
      @Post("bare")
      bare() {}

      @Post("marked")
      @NoImpersonation("billing")
      marked() {}

      @Post("metadata-only")
      @SetMetadata(NO_IMPERSONATION_KEY, "billing")
      metadataOnly() {}

      @Patch("patched")
      patched() {}

      @Post("quote")
      quote() {}

      @Get("read")
      read() {}
    }

    @NoImpersonation("billing")
    class WholeClass {
      @Post("a")
      a() {}
    }

    it("names a bare @Post, a metadata-only handler and any other non-GET verb", () => {
      expect(unprotectedMutations(Fake, ["quote"]).sort()).toEqual(
        ["Fake.bare", "Fake.metadataOnly", "Fake.patched"].sort(),
      );
    });

    it("without the allow-list the read-like POST is named too", () => {
      expect(unprotectedMutations(Fake)).toContain("Fake.quote");
    });

    it("ignores a GET and accepts a decorated handler or a decorated class", () => {
      const names = unprotectedMutations(Fake, ["quote"]);
      expect(names).not.toContain("Fake.read");
      expect(names).not.toContain("Fake.marked");
      expect(unprotectedMutations(WholeClass)).toEqual([]);
    });
  });
});

describe("every controller in billing/ is classified (a new one cannot dodge the pin)", () => {
  const dir = __dirname;
  const controllers = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".controller.ts"))
    .sort();

  /** Tenant-facing: pinned above. */
  const TENANT = ["settings-billing.controller.ts"];
  /** Not tenant-facing, with why. */
  const SUPER_ADMIN_ONLY = [
    "billing.controller.ts",
    "feature-config.controller.ts",
    "plan-admin.controller.ts",
  ];
  const OTHER: Record<string, string> = {
    "billing-webhook.controller.ts":
      "provider webhook, authenticated by the signed payload, no user session",
    "plan-catalog.controller.ts": "public read of the plan catalog, GET only",
  };

  it("each file is tenant-facing (pinned), super-admin only, or a listed exception", () => {
    const known = new Set([...TENANT, ...SUPER_ADMIN_ONLY, ...Object.keys(OTHER)]);
    expect(controllers.filter((f) => !known.has(f))).toEqual([]);
    for (const f of known) expect(controllers).toContain(f);
  });

  it.each(SUPER_ADMIN_ONLY)("%s is behind SuperAdminGuard", (file) => {
    expect(fs.readFileSync(path.join(dir, file), "utf8")).toContain("SuperAdminGuard");
  });

  it("the public catalog controller has no mutating route", () => {
    const src = fs.readFileSync(path.join(dir, "plan-catalog.controller.ts"), "utf8");
    expect(src).not.toMatch(/@(Post|Put|Patch|Delete)\(/);
  });
});

describe("every controller in the payment-setup directories is classified (SA-778)", () => {
  const SRC = path.join(__dirname, "..");
  const controllersIn = (dir: string) =>
    fs
      .readdirSync(path.join(SRC, dir))
      .filter((f) => f.endsWith(".controller.ts"))
      .sort();

  /** Tenant-facing payment setup: pinned above (the whole file's mutating handlers carry the marker). */
  const PINNED: Record<string, string[]> = {
    "stripe-connect": ["stripe-connect.controller.ts"],
  };
  /** Everything else in those directories, with why it is not pinned here. */
  const OTHER: Record<string, Record<string, string>> = {
    "stripe-connect": {},
    "payment-requests": {
      "payment-requests.controller.ts":
        "tenant review of buyer payment requests (approve and reject): a different action class, left to a follow-up ruling",
      "buyer-payments.controller.ts": "buyer-portal principal, not a staff session",
      "connect-webhook.controller.ts":
        "provider webhook, authenticated by the signed payload, no user session",
    },
  };

  it.each(Object.keys(OTHER))("%s: each controller file is pinned or a listed exception", (dir) => {
    const known = new Set([...(PINNED[dir] ?? []), ...Object.keys(OTHER[dir])]);
    const files = controllersIn(dir);
    expect(files.filter((f) => !known.has(f))).toEqual([]);
    for (const f of known) expect(files).toContain(f);
    for (const reason of Object.values(OTHER[dir])) expect(reason.length).toBeGreaterThan(20);
  });
});
