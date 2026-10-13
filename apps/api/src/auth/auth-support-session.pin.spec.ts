import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { AuthController } from "./auth.controller";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { NO_IMPERSONATION_KEY, NoImpersonationGuard } from "./guards/no-impersonation.guard";

/**
 * SA-778 pin (account scope): the handlers that change the signed-in user's own credentials or attach an
 * identity to the account carry `@NoImpersonation("account")`, and the guard runs AFTER JwtAuthGuard.
 *
 * The set is explicit, not "every non-GET": `GET auth/google/link` has a side effect (it starts an
 * account link), so a verb-based detector would miss it. A GET with a side effect is NOT covered by the
 * billing pin's non-GET rule; mark it and add it here by hand.
 */
const ACCOUNT_HANDLERS = ["changePassword", "setPassword", "linkGoogleUrl", "appleLink"] as const;

/** Every other AuthController handler that needs a JwtAuthGuard session, and why a support session keeps it. */
const SESSION_HANDLERS_LEFT_OPEN: Record<string, string> = {
  logout: "ends the support session itself; it revokes nothing for an impersonated token",
  mintHandoff:
    "already refuses an impersonated token inside StaffHandoffService.mint (before any code is minted)",
  listSessions: "a read",
  revokeSession:
    "revokes one of the caller's own sessions; changes no credential or linked identity",
};

const proto = AuthController.prototype as unknown as Record<string, unknown>;
const guardsOf = (name: string) =>
  (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ?? []) as unknown[];

describe("account routes carry @NoImpersonation('account') (SA-778 pin)", () => {
  it.each(ACCOUNT_HANDLERS)("%s is marked 'account' and guarded", (name) => {
    expect(Reflect.getMetadata(NO_IMPERSONATION_KEY, proto[name] as object)).toBe("account");
    expect(guardsOf(name)).toContain(NoImpersonationGuard);
  });

  it.each(ACCOUNT_HANDLERS)(
    "%s authenticates first: JwtAuthGuard sits before NoImpersonationGuard",
    (name) => {
      const guards = guardsOf(name);
      expect(guards.indexOf(JwtAuthGuard)).toBeGreaterThanOrEqual(0);
      expect(guards.indexOf(JwtAuthGuard)).toBeLessThan(guards.indexOf(NoImpersonationGuard));
    },
  );

  it("every other JwtAuthGuard-gated handler is a reviewed, listed exception (a new one is a conscious add)", () => {
    const gated = Object.getOwnPropertyNames(proto).filter((name) => {
      const fn = proto[name];
      if (name === "constructor" || typeof fn !== "function") return false;
      if (Reflect.getMetadata(METHOD_METADATA, fn as object) === undefined) return false;
      return guardsOf(name).includes(JwtAuthGuard);
    });
    const open = gated.filter((n) => !(ACCOUNT_HANDLERS as readonly string[]).includes(n));
    expect(open.sort()).toEqual(Object.keys(SESSION_HANDLERS_LEFT_OPEN).sort());
    for (const why of Object.values(SESSION_HANDLERS_LEFT_OPEN)) {
      expect(why.length).toBeGreaterThan(5);
    }
  });

  it("the account set is real: the Google link is a GET with a side effect, the rest are POSTs", () => {
    const verb = (n: string) => Reflect.getMetadata(METHOD_METADATA, proto[n] as object);
    expect(verb("linkGoogleUrl")).toBe(RequestMethod.GET);
    for (const n of ["changePassword", "setPassword", "appleLink"]) {
      expect(verb(n)).toBe(RequestMethod.POST);
    }
  });
});
