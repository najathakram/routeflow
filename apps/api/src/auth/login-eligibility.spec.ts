/**
 * #2653 (SA-542a/b): the handoff exchange signs someone in WITHOUT a password, so it must apply the
 * exact rule the password logins apply once the password checks out. This pins isLoginEligible /
 * isBuyerLoginEligible to the REAL AuthService.validateUser and BuyerAuthService.login across every
 * account state, so the helpers and the login paths can never drift.
 */
import * as bcrypt from "bcrypt";
import { UnauthorizedException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { BuyerAuthService } from "../buyer/buyer-auth.service";
import { isBuyerLoginEligible, isLoginEligible } from "./login-eligibility";

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

describe("isBuyerLoginEligible === BuyerAuthService.login's post-password rule (buyers)", () => {
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
    expect(isBuyerLoginEligible(account as never)).toBe(viaLogin);
  });
});
