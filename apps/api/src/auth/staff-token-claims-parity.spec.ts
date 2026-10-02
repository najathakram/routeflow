import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { AppleOAuthService } from "./apple-oauth.service";
import { createMockPrisma } from "../testing/prisma-mock";

// SA-598c / #2486: the Apple staff access token must carry exactly the claim keys a password
// login mints (isAdmin, canActAsDriver were missing). Entitlement claims are excluded on both
// sides: claimsFor returns null so they add no keys.

jest.mock("bcrypt", () => ({
  hash: jest.fn().mockResolvedValue("$2b$10$placeholder"),
  compare: jest.fn(),
  genSalt: jest.fn(),
}));

const JWT_CONFIG = {
  secret: "test-secret",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "7d",
};

function baseUser(over: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    username: "staff",
    email: "staff@example.com",
    password: "$2b$10$hashed",
    role: "OPERATOR",
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: "tenant-1",
    isAdmin: false,
    canActAsDriver: false,
    ...over,
  };
}

async function mintBoth(user: Record<string, unknown>) {
  const config = { get: (k: string) => (k === "jwt" ? JWT_CONFIG : undefined) } as ConfigService;
  const entitlements = { claimsFor: jest.fn().mockResolvedValue(null) };

  const authSign = jest.fn().mockReturnValue("t");
  const authPrisma = createMockPrisma();
  (authPrisma as any).tenant.findUnique.mockResolvedValue({ slug: "acme" });
  const auth = new AuthService(
    authPrisma as any,
    {} as any,
    {
      sign: authSign,
      decode: jest.fn().mockReturnValue({ exp: 9999999999 }),
    } as unknown as JwtService,
    config as any,
    { send: jest.fn() } as any,
    entitlements as any,
  );
  // AuthService.login is driven with the user row exactly as validateUser would hand it over.
  await auth.login(user as any);

  const appleSign = jest.fn().mockReturnValue("t");
  const applePrisma = createMockPrisma();
  const apple = new AppleOAuthService(
    applePrisma as any,
    {
      sign: appleSign,
      decode: jest.fn().mockReturnValue({ exp: 9999999999 }),
    } as unknown as JwtService,
    config,
    { send: jest.fn() } as any,
    entitlements as any,
    { encrypt: jest.fn((v: string) => v), decrypt: jest.fn((v: string) => v) } as any,
  );
  try {
    await (apple as any).issueUserTokenPair(user, "acme");
  } finally {
    (apple as any).redis?.disconnect?.();
  }

  return { authPayload: authSign.mock.calls[0][0], applePayload: appleSign.mock.calls[0][0] };
}

describe("staff token claims parity (AuthService.login vs Apple staff token)", () => {
  it("mints the same claim key set for the same staff row", async () => {
    const { authPayload, applePayload } = await mintBoth(baseUser());
    expect(Object.keys(applePayload).sort()).toEqual(Object.keys(authPayload).sort());
  });

  it("isAdmin is true for a TENANT_ADMIN role", async () => {
    const { applePayload } = await mintBoth(baseUser({ role: "TENANT_ADMIN" }));
    expect(applePayload.isAdmin).toBe(true);
  });

  it("isAdmin is true for an isAdmin=true user", async () => {
    const { applePayload } = await mintBoth(baseUser({ isAdmin: true }));
    expect(applePayload.isAdmin).toBe(true);
  });

  it("isAdmin is false for a plain OPERATOR", async () => {
    const { applePayload } = await mintBoth(baseUser());
    expect(applePayload.isAdmin).toBe(false);
  });

  it("canActAsDriver passes through true and false", async () => {
    expect((await mintBoth(baseUser({ canActAsDriver: true }))).applePayload.canActAsDriver).toBe(
      true,
    );
    expect((await mintBoth(baseUser({ canActAsDriver: false }))).applePayload.canActAsDriver).toBe(
      false,
    );
  });

  it("canActAsDriver defaults to false when undefined", async () => {
    const { applePayload } = await mintBoth(baseUser({ canActAsDriver: undefined }));
    expect(applePayload.canActAsDriver).toBe(false);
  });
});
