/**
 * #2653 (SA-542a/b): the handoff exchange signs someone in WITHOUT a password, so it must apply the
 * exact rule the password logins apply once the password checks out. Both login paths now CALL
 * login-eligibility.ts (one rule, SA-070); this pins its verdicts against the REAL
 * AuthService.validateUser and BuyerAuthService.login across every account state, and (SA-542c)
 * that each caller keeps the timing-oracle order around bcrypt.
 */
import * as bcrypt from "bcrypt";
import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { BuyerAuthService } from "../buyer/buyer-auth.service";
import { isLoginEligible } from "./login-eligibility";

// bcrypt.compare stays REAL; the wrapper only records the calls, for SA-542c's order pins below.
jest.mock("bcrypt", () => {
  const actual = jest.requireActual("bcrypt");
  return { ...actual, compare: jest.fn((...args: unknown[]) => actual.compare(...args)) };
});
const compareSpy = bcrypt.compare as unknown as jest.Mock;

const FUTURE = new Date(Date.now() + 7 * 86_400_000); // a week: never a collection-time fuse (B793)
const PAST = new Date(Date.now() - 3_600_000);
const STATES: Array<[string, Record<string, unknown>]> = [
  ["active", {}],
  ["deleted", { deletedAt: PAST }],
  ["locked", { lockedUntil: FUTURE }],
  ["lock expired", { lockedUntil: PAST }],
  ["inactive", { status: "INACTIVE" }],
  ["suspended", { status: "SUSPENDED" }],
];

describe("isLoginEligible === validateUser's post-password rule (staff)", () => {
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash("pw", 4);
  });

  it.each(STATES)("%s", async (_name, over) => {
    const user = {
      id: "u1",
      username: "op",
      password: hash,
      status: "ACTIVE",
      deletedAt: null,
      lockedUntil: null,
      failedLoginAttempts: 0,
      ...over,
    };
    const usersService = { findByUsername: jest.fn().mockResolvedValue(user) };
    const prisma = { user: { update: jest.fn().mockResolvedValue({}) } };
    const svc = Object.create(AuthService.prototype) as AuthService;
    Object.assign(svc, { usersService, prisma, recordFailedLogin: jest.fn() });
    const viaLogin = (await svc.validateUser("op", "pw", "t1")) !== null;
    expect(isLoginEligible(user as never)).toBe(viaLogin);
  });
});

describe("isLoginEligible === BuyerAuthService.login's post-password rule (buyers)", () => {
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash("pw", 4);
  });

  it.each(STATES)("%s", async (_name, over) => {
    const account = {
      id: "b1",
      email: "buyer@acme.test",
      name: "Acme Buyer",
      passwordHash: hash,
      passwordSet: true,
      status: "ACTIVE",
      deletedAt: null,
      lockedUntil: null,
      failedLoginAttempts: 0,
      ...over,
    };
    const prisma = {
      buyerAccount: {
        findUnique: jest.fn().mockResolvedValue(account),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const svc = Object.create(BuyerAuthService.prototype) as BuyerAuthService;
    Object.assign(svc, {
      prisma,
      recordFailedLogin: jest.fn(),
      issueBuyerTokenPair: jest.fn().mockResolvedValue({ accessToken: "a", refreshToken: "r" }),
    });
    const viaLogin = await svc
      .login({ email: "buyer@acme.test", password: "pw" } as never)
      .then(() => true)
      .catch((e) => {
        if (e instanceof UnauthorizedException) return false;
        throw e;
      });
    expect(isLoginEligible(account as never)).toBe(viaLogin);
  });
});

/**
 * SA-542c: the helper decides eligibility, the CALLER keeps the order. deletedAt and the lockout
 * refuse BEFORE bcrypt (no counter churn); status is consulted only AFTER bcrypt ran, so a
 * non-ACTIVE account answers exactly like an active one given a wrong password (B213).
 */
describe("SA-542c: the login paths keep the timing-oracle order", () => {
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash("pw", 4);
  });
  beforeEach(() => compareSpy.mockClear());

  function staff(over: Record<string, unknown>) {
    const user = {
      id: "u1",
      username: "op",
      password: hash,
      status: "ACTIVE",
      deletedAt: null,
      lockedUntil: null,
      failedLoginAttempts: 0,
      ...over,
    };
    const svc = Object.create(AuthService.prototype) as AuthService;
    Object.assign(svc, {
      usersService: { findByUsername: jest.fn().mockResolvedValue(user) },
      prisma: { user: { update: jest.fn().mockResolvedValue({}) } },
      recordFailedLogin: jest.fn(),
    });
    return svc;
  }

  function buyer(over: Record<string, unknown>) {
    const account = {
      id: "b1",
      email: "buyer@acme.test",
      name: "Acme Buyer",
      passwordHash: hash,
      passwordSet: true,
      status: "ACTIVE",
      deletedAt: null,
      lockedUntil: null,
      failedLoginAttempts: 0,
      ...over,
    };
    const svc = Object.create(BuyerAuthService.prototype) as BuyerAuthService;
    Object.assign(svc, {
      prisma: {
        buyerAccount: {
          findUnique: jest.fn().mockResolvedValue(account),
          update: jest.fn().mockResolvedValue({}),
        },
      },
      recordFailedLogin: jest.fn(),
      issueBuyerTokenPair: jest.fn().mockResolvedValue({ accessToken: "a", refreshToken: "r" }),
    });
    return svc;
  }
  const buyerRefusal = (svc: BuyerAuthService, password: string) =>
    svc.login({ email: "buyer@acme.test", password } as never).then(
      () => "signed-in",
      (e: Error) => `${e.constructor.name}: ${e.message}`,
    );

  it("staff: a wrong password on an INACTIVE user answers like one on an ACTIVE user, bcrypt ran in both", async () => {
    const active = await staff({}).validateUser("op", "wrong", "t1");
    const inactive = await staff({ status: "INACTIVE" }).validateUser("op", "wrong", "t1");
    expect(active).toBeNull();
    expect(inactive).toBeNull();
    expect(compareSpy).toHaveBeenCalledTimes(2);
  });

  it("staff: the RIGHT password on an INACTIVE user still runs bcrypt before it is refused", async () => {
    expect(await staff({ status: "INACTIVE" }).validateUser("op", "pw", "t1")).toBeNull();
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });

  it("staff: deleted and locked users are refused WITHOUT bcrypt (placement unchanged)", async () => {
    expect(await staff({ deletedAt: new Date() }).validateUser("op", "pw", "t1")).toBeNull();
    expect(await staff({ lockedUntil: FUTURE }).validateUser("op", "pw", "t1")).toBeNull();
    expect(compareSpy).not.toHaveBeenCalled();
  });

  it("buyer: a wrong password on a SUSPENDED account is the same 401 as on an ACTIVE one, bcrypt ran in both", async () => {
    const active = await buyerRefusal(buyer({}), "wrong");
    const suspended = await buyerRefusal(buyer({ status: "SUSPENDED" }), "wrong");
    expect(active).toBe("UnauthorizedException: Invalid credentials");
    expect(suspended).toBe(active);
    expect(compareSpy).toHaveBeenCalledTimes(2);
  });

  it("buyer: deleted and locked accounts are refused WITHOUT bcrypt (placement unchanged)", async () => {
    expect(await buyerRefusal(buyer({ deletedAt: new Date() }), "pw")).toBe(
      "UnauthorizedException: Invalid credentials",
    );
    expect(await buyerRefusal(buyer({ lockedUntil: FUTURE }), "pw")).toBe(
      "UnauthorizedException: Invalid credentials",
    );
    expect(compareSpy).not.toHaveBeenCalled();
  });
});
