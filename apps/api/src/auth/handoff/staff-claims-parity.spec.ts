/**
 * #2653 (SA-598c): a handoff session must carry the SAME staff claims as a password sign-in:
 * the same key set and values in the access token (issuer-side fields, isAdmin, canActAsDriver,
 * hasPassword, tenant, entitlement snapshot) and in the refresh token, and the same `user` body.
 * StaffHandoffService.exchange mints through AuthService.login, and this pins it against a real
 * password login (validateUser -> login) using a REAL JwtService, so a future fork of the mint
 * (a second sign() call with hand-built claims) turns red on the first missing or extra key.
 */
import * as bcrypt from "bcrypt";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "../auth.service";
import { StaffHandoffService } from "./staff-handoff.service";

const JWT = {
  secret: "s".repeat(40),
  refreshSecret: "r".repeat(40),
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};
const jwt = new JwtService({});

function makeAuth(userRow: Record<string, unknown>) {
  const svc = Object.create(AuthService.prototype) as AuthService;
  Object.assign(svc, {
    jwtService: jwt,
    configService: { get: () => JWT },
    prisma: {
      tenant: { findUnique: jest.fn().mockResolvedValue({ slug: "acme" }) },
      user: { update: jest.fn().mockResolvedValue({}) },
      refreshToken: { count: jest.fn().mockResolvedValue(1) },
    },
    usersService: { findByUsername: jest.fn().mockResolvedValue(userRow) },
    entitlements: {
      claimsFor: jest.fn().mockResolvedValue({ plan: "PRO", flags: ["returns"], seats: 5 }),
    },
    emailService: { send: jest.fn().mockResolvedValue(undefined) },
    storeRefreshToken: jest.fn().mockResolvedValue(undefined),
    recordFailedLogin: jest.fn(),
  });
  return svc;
}

const decode = (t: string, secret: string) => {
  const { iat: _i, exp: _e, ...rest } = jwt.verify(t, { secret }) as Record<string, unknown>;
  return rest;
};

describe("handoff mints the same staff claims as AuthService.login (SA-598c)", () => {
  let hash: string;
  beforeAll(async () => {
    hash = await bcrypt.hash("pw", 4);
  });

  it.each([
    ["OPERATOR", { role: "OPERATOR", isAdmin: false, canActAsDriver: false }],
    ["OPERATOR who can drive", { role: "OPERATOR", isAdmin: false, canActAsDriver: true }],
    ["TENANT_ADMIN", { role: "TENANT_ADMIN", isAdmin: false, canActAsDriver: true }],
  ])("%s: identical access claims, refresh claims and user body", async (_n, over) => {
    const userRow = {
      id: "u1",
      username: "op",
      email: "op@acme.test",
      password: hash,
      status: "ACTIVE",
      deletedAt: null,
      lockedUntil: null,
      failedLoginAttempts: 0,
      forcePasswordChange: false,
      tenantId: "t1",
      ...over,
    };
    const auth = makeAuth(userRow);

    // A password sign-in.
    const validated = await auth.validateUser("op", "pw", "t1");
    const viaPassword = await auth.login(validated as never, { userAgent: "ua" });

    // A handoff sign-in for the same account.
    const codes = {
      consume: jest.fn().mockResolvedValue({ userId: "u1", tenantId: "t1", deviceId: "d1" }),
    };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(userRow) } };
    const viaHandoff = await new StaffHandoffService(
      codes as never,
      prisma as never,
      auth,
    ).exchange("code", { userAgent: "ua" });

    const a = decode(viaPassword.accessToken, JWT.secret);
    const b = decode(viaHandoff.accessToken, JWT.secret);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(b).toEqual(a);
    // The claims SA-598c names, spelled out so a rename cannot slip through.
    for (const k of [
      "sub",
      "username",
      "role",
      "status",
      "forcePasswordChange",
      "tenantId",
      "tenantSlug",
      "isAdmin",
      "canActAsDriver",
      "hasPassword",
      "plan",
      "flags",
      "seats",
    ]) {
      expect(b).toHaveProperty(k);
    }
    expect(decode(viaHandoff.refreshToken, JWT.refreshSecret)).toEqual(
      decode(viaPassword.refreshToken, JWT.refreshSecret),
    );
    expect(viaHandoff.user).toEqual(viaPassword.user);
  });
});
