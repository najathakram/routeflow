import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { GoogleOAuthService } from "./google-oauth.service";
import { isProviderIdUniqueViolation } from "./oauth-account-link";

/**
 * A googleId unique violation raised by a link write (CAS updateMany / buyer create) is another
 * row already owning that sub: it must surface as the existing `google_id_taken` outcome, not a
 * 500. The Prisma 7 driver adapter carries the constraint in
 * `meta.driverAdapterError.cause.constraint` (`{ index }` or `{ fields }`); there is no
 * `meta.target`. Any other unique violation (email) must propagate unchanged.
 */
function p2002(meta: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta,
  });
}
const adapter = (constraint: { index?: string; fields?: string[] } | undefined) => ({
  driverAdapterError: {
    name: "DriverAdapterError",
    cause: { kind: "UniqueConstraintViolation", constraint },
  },
});

describe("isProviderIdUniqueViolation", () => {
  const cases: Array<[string, unknown, "googleId" | "appleId", boolean]> = [
    [
      "User(tenantId, googleId) index",
      p2002(adapter({ index: "User_tenantId_googleId_key" })),
      "googleId",
      true,
    ],
    [
      "BuyerAccount googleId index",
      p2002(adapter({ index: "BuyerAccount_googleId_key" })),
      "googleId",
      true,
    ],
    [
      "fields [tenantId, googleId]",
      p2002(adapter({ fields: ["tenantId", "googleId"] })),
      "googleId",
      true,
    ],
    ["fields [googleId]", p2002(adapter({ fields: ["googleId"] })), "googleId", true],
    ["quoted fields [googleId]", p2002(adapter({ fields: ['"googleId"'] })), "googleId", true],
    [
      "quoted fields [tenantId, googleId]",
      p2002(adapter({ fields: ['"tenantId"', '"googleId"'] })),
      "googleId",
      true,
    ],
    [
      "quoted email fields",
      p2002(adapter({ fields: ['"tenantId"', '"email"'] })),
      "googleId",
      false,
    ],
    ["quoted appleId fields", p2002(adapter({ fields: ['"appleId"'] })), "appleId", true],
    [
      "quoted appleId fields vs googleId",
      p2002(adapter({ fields: ['"appleId"'] })),
      "googleId",
      false,
    ],
    [
      "quoted googleId fields vs appleId",
      p2002(adapter({ fields: ['"googleId"'] })),
      "appleId",
      false,
    ],
    ["email index", p2002(adapter({ index: "User_tenantId_email_key" })), "googleId", false],
    ["email fields", p2002(adapter({ fields: ["tenantId", "email"] })), "googleId", false],
    [
      "appleId index vs googleId column",
      p2002(adapter({ index: "User_tenantId_appleId_key" })),
      "googleId",
      false,
    ],
    [
      "googleId index vs appleId column",
      p2002(adapter({ index: "BuyerAccount_googleId_key" })),
      "appleId",
      false,
    ],
    ["no constraint", p2002(adapter(undefined)), "googleId", false],
    ["no meta", p2002({}), "googleId", false],
    ["legacy meta.target is not trusted", p2002({ target: ["googleId"] }), "googleId", false],
    [
      "other code",
      new Prisma.PrismaClientKnownRequestError("x", {
        code: "P2025",
        clientVersion: "test",
        meta: adapter({ index: "BuyerAccount_googleId_key" }),
      }),
      "googleId",
      false,
    ],
    ["plain Error", new Error("boom"), "googleId", false],
    ["null", null, "googleId", false],
  ];
  it.each(cases)("%s", (_n, err, column, expected) => {
    expect(isProviderIdUniqueViolation(err, column)).toBe(expected);
  });
});

describe("GoogleOAuthService — googleId P2002 on a link write maps to google_id_taken", () => {
  const TENANT = { id: "tenant-1", slug: "acme", status: "ACTIVE" };
  const STAFF = {
    id: "user-1",
    tenantId: "tenant-1",
    username: "op1",
    role: "OPERATOR",
    status: "ACTIVE",
    email: "op@acme.example",
    googleId: null as string | null,
    forcePasswordChange: false,
  };

  function build() {
    const config = {
      get: (key: string) =>
        key === "jwt"
          ? { secret: "s", refreshSecret: "r", expiresIn: "15m", refreshExpiresIn: "30d" }
          : undefined,
    } as unknown as ConfigService;
    const prisma = {
      tenant: { findFirst: jest.fn().mockResolvedValue(TENANT) },
      user: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      },
      buyerAccount: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      buyerRefreshToken: { deleteMany: jest.fn(), upsert: jest.fn() },
      refreshToken: { upsert: jest.fn().mockResolvedValue({}) },
      customerLink: { count: jest.fn().mockResolvedValue(0) },
    } as any;
    const service = new GoogleOAuthService(
      prisma,
      {
        sign: jest.fn(() => "signed"),
        decode: jest.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
      } as unknown as JwtService,
      config,
      { send: jest.fn().mockResolvedValue({ delivered: true }) } as any,
      { claimsFor: jest.fn().mockResolvedValue(null) } as any,
    );
    return { service, prisma };
  }

  const staffProfile = () =>
    ({ type: "tenant", googleId: "google-sub-1", email: STAFF.email, tenantSlug: "acme" }) as any;
  const buyerProfile = () =>
    ({
      type: "tenant",
      context: "buyer-standalone",
      googleId: "google-sub-1",
      email: "b@example.com",
      name: "B",
    }) as any;
  const googleTaken = () => p2002(adapter({ index: "User_tenantId_googleId_key" }));

  it("staff CAS write: googleId index (name form) -> google_id_taken", async () => {
    const { service, prisma } = build();
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
    prisma.user.updateMany.mockRejectedValue(googleTaken());
    const err = await service.findOrCreateUser(staffProfile()).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe("google_id_taken");
  });

  it("staff CAS write: googleId fields form -> google_id_taken", async () => {
    const { service, prisma } = build();
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
    prisma.user.updateMany.mockRejectedValue(p2002(adapter({ fields: ["tenantId", "googleId"] })));
    await expect(service.findOrCreateUser(staffProfile())).rejects.toThrow(
      new ForbiddenException("google_id_taken"),
    );
  });

  it("platform CAS write -> google_id_taken", async () => {
    const { service, prisma } = build();
    prisma.user.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...STAFF, tenantId: null, role: "SUPER_ADMIN" });
    prisma.user.updateMany.mockRejectedValue(googleTaken());
    await expect(
      service.findOrCreateUser({ type: "platform", googleId: "g", email: STAFF.email } as any),
    ).rejects.toThrow(new ForbiddenException("google_id_taken"));
  });

  it("buyer CAS write -> google_id_taken", async () => {
    const { service, prisma } = build();
    prisma.buyerAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "buyer-1",
      email: "b@example.com",
      status: "ACTIVE",
      passwordSet: true,
      emailVerified: true,
      googleId: null,
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.updateMany.mockRejectedValue(
      p2002(adapter({ index: "BuyerAccount_googleId_key" })),
    );
    await expect(service.findOrCreateUser(buyerProfile())).rejects.toThrow(
      new ForbiddenException("google_id_taken"),
    );
  });

  it("buyer auto-create -> google_id_taken on a googleId violation", async () => {
    const { service, prisma } = build();
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.buyerAccount.create.mockRejectedValue(
      p2002(adapter({ index: "BuyerAccount_googleId_key" })),
    );
    await expect(service.findOrCreateUser(buyerProfile())).rejects.toThrow(
      new ForbiddenException("google_id_taken"),
    );
  });

  it("linkGoogleAccount CAS write -> google_id_taken", async () => {
    const { service, prisma } = build();
    prisma.user.findUnique.mockResolvedValue({ ...STAFF });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.updateMany.mockRejectedValue(googleTaken());
    await expect(
      service.linkGoogleAccount({ linkUserId: "user-1", googleId: "g", email: "x@y.z" } as any),
    ).rejects.toThrow(new ForbiddenException("google_id_taken"));
  });

  it("a DIFFERENT constraint (email) is re-thrown unchanged", async () => {
    const { service, prisma } = build();
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
    const emailDup = p2002(adapter({ index: "User_tenantId_email_key" }));
    prisma.user.updateMany.mockRejectedValue(emailDup);
    await expect(service.findOrCreateUser(staffProfile())).rejects.toBe(emailDup);
  });

  it("a buyer-create email violation is re-thrown unchanged", async () => {
    const { service, prisma } = build();
    prisma.buyerAccount.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    const emailDup = p2002(adapter({ fields: ["email"] }));
    prisma.buyerAccount.create.mockRejectedValue(emailDup);
    await expect(service.findOrCreateUser(buyerProfile())).rejects.toBe(emailDup);
  });

  it("a non-P2002 error is re-thrown unchanged", async () => {
    const { service, prisma } = build();
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...STAFF });
    const boom = new Error("connection reset");
    prisma.user.updateMany.mockRejectedValue(boom);
    await expect(service.findOrCreateUser(staffProfile())).rejects.toBe(boom);
  });
});
