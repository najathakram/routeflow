import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { AuthService } from "./auth.service";
import { EmailService } from "../email/email.service";
import { UsersService } from "../users/users.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { EntitlementsService } from "../billing/entitlements.service";
import { mockClaimTransaction } from "../testing/link-claim-tx";

jest.mock("bcrypt", () => ({ compare: jest.fn(), hash: jest.fn(), genSalt: jest.fn() }));

const JWT_CONFIG = {
  secret: "test-jwt-secret-0123456789-abcdefghijklmnop",
  refreshSecret: "test-refresh-secret",
  expiresIn: "15m",
  refreshExpiresIn: "30d",
};

const URLS_CONFIG = { web: "https://web.test", mobileWeb: "https://mobile.test" };

const ACTIVE_USER = {
  id: "user-1",
  email: "alice@example.com",
  username: "alice",
  password: "$2b$10$hashed",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  deletedAt: null,
  forcePasswordChange: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

type UserRow = {
  id: string;
  tenantId: string;
  email: string;
  createdAt: Date;
  tenant: { name: string } | null;
  [k: string]: unknown;
};

const ROW_A: UserRow = {
  id: "user-a",
  tenantId: "t-a",
  email: "alice@example.com",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  tenant: { name: "Alpha Supply" },
};
const ROW_B: UserRow = {
  id: "user-b",
  tenantId: "t-b",
  email: "alice@example.com",
  createdAt: new Date("2026-02-01T00:00:00Z"),
  tenant: { name: "Bravo Foods" },
};

/** The service is called with an optional third argument (the resolved business). */
type ResetCall = (
  email: string,
  surface?: string,
  tenantId?: string,
) => Promise<{ message: string }>;

describe("AuthService — password reset (RF-018)", () => {
  let service: AuthService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let emailService: { send: jest.Mock };

  /** One fixture list drives both user lookups, honouring email, tenant, active/not-deleted, order, take. */
  const stubUsers = (rows: UserRow[]) => {
    const match = (where: Record<string, unknown> = {}) =>
      rows.filter(
        (r) =>
          (where.email === undefined || r.email === where.email) &&
          (where.tenantId === undefined || r.tenantId === where.tenantId) &&
          (r.deletedAt === undefined || r.deletedAt === null) &&
          (r.status === undefined || r.status === "ACTIVE"),
      );
    (prisma.user.findFirst as jest.Mock).mockImplementation(
      async (args: { where?: Record<string, unknown> } = {}) => match(args.where)[0] ?? null,
    );
    (prisma.user.findMany as jest.Mock).mockImplementation(
      async (args: { where?: Record<string, unknown>; take?: number } = {}) => {
        const found = match(args.where);
        return args.take === undefined ? found : found.slice(0, args.take);
      },
    );
  };
  const reset = (email: string, surface?: string, tenantId?: string) =>
    (service.requestPasswordReset as unknown as ResetCall).call(service, email, surface, tenantId);
  const createdUserIds = () =>
    (prisma.passwordResetToken.create as jest.Mock).mock.calls.map((c) => c[0].data.userId);
  const sentMails = () =>
    emailService.send.mock.calls.map((c) => c[0] as { html: string; text: string; to: string });

  beforeEach(async () => {
    prisma = createMockPrisma();
    emailService = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: UsersService,
          useValue: {
            findByUsername: jest.fn(),
            findByUsernameCrossTenant: jest.fn().mockResolvedValue(null),
            findByEmailCrossTenant: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue("tok"),
            verify: jest.fn(),
            decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === "urls" ? URLS_CONFIG : JWT_CONFIG)),
          },
        },
        { provide: EmailService, useValue: emailService },
        {
          provide: EntitlementsService,
          useValue: { claimsFor: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── Unit: token hashing helper ─────────────────────────────────────────────

  describe("hashTokenPublic", () => {
    it("produces a deterministic SHA-256 hex string", () => {
      const raw = "abc123";
      const result = service.hashTokenPublic(raw);
      const expected = crypto.createHash("sha256").update(raw).digest("hex");
      expect(result).toBe(expected);
    });

    it("different inputs produce different hashes", () => {
      expect(service.hashTokenPublic("aaa")).not.toBe(service.hashTokenPublic("bbb"));
    });
  });

  // ── requestPasswordReset ───────────────────────────────────────────────────

  describe("requestPasswordReset", () => {
    it("creates a token row and fires email when user exists", async () => {
      stubUsers([{ ...ACTIVE_USER, tenantId: "t-1", tenant: { name: "Alpha Supply" } }]);
      (prisma.passwordResetToken.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.passwordResetToken.create as jest.Mock).mockResolvedValue({});

      const result = await service.requestPasswordReset("alice@example.com");

      expect(result.message).toContain("If that address is registered");
      expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(1);
      expect((prisma.user.findMany as jest.Mock).mock.calls[0]![0].where).toEqual(
        expect.objectContaining({
          email: "alice@example.com",
          deletedAt: null,
          status: "ACTIVE",
        }),
      );

      const createArg = (prisma.passwordResetToken.create as jest.Mock).mock.calls[0]![0];
      expect(createArg.data.userId).toBe("user-1");
      expect(createArg.data.tokenHash).toBeDefined();
      expect(createArg.data.expiresAt).toBeInstanceOf(Date);

      // email is fire-and-forget — flush microtasks
      await Promise.resolve();
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "alice@example.com",
          subject: expect.stringContaining("Reset"),
          senderClass: "platform",
        }),
      );
    });

    it("returns same message when user does NOT exist (no enumeration)", async () => {
      stubUsers([]);

      const result = await service.requestPasswordReset("nobody@example.com");

      expect(result.message).toContain("If that address is registered");
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it("links to the current website by default (surface omitted), never the retired mobile-web address", async () => {
      stubUsers([{ ...ACTIVE_USER, tenantId: "t-1", tenant: { name: "Alpha Supply" } }]);

      await service.requestPasswordReset("alice@example.com");
      await Promise.resolve();

      const html = emailService.send.mock.calls[0]![0].html as string;
      expect(html).toContain("https://web.test/reset-password?token=");
      expect(html).not.toContain("https://mobile.test");
      // The URL comes from config, never a hardcoded domain
      expect(html).not.toContain("routeflowmobile-production");
    });

    // W-1163: the reset mail wears the RouteFlow layout, shows a short link text instead of the
    // token URL, and ships a text part that carries the full link.
    it("is the branded layout: a button, no token URL as visible text, and a matching text part", async () => {
      stubUsers([{ ...ACTIVE_USER, tenantId: "t-1", tenant: { name: "Alpha Supply" } }]);

      await service.requestPasswordReset("alice@example.com");
      await Promise.resolve();

      const sent = emailService.send.mock.calls[0]![0] as { html: string; text: string };
      const shown = sent.html.replace(/<[^>]+>/g, "");
      expect(sent.html).toContain('data-rf-layout="v1"');
      expect(sent.html).toContain(">Choose a new password</a>");
      expect(shown).not.toContain("token=");
      expect(shown).toContain("web.test/reset-password");
      expect(sent.text).toContain("Choose a new password: https://web.test/reset-password?token=");
    });

    it('links to the web base URL when surface="web"', async () => {
      stubUsers([{ ...ACTIVE_USER, tenantId: "t-1", tenant: { name: "Alpha Supply" } }]);

      await service.requestPasswordReset("alice@example.com", "web");
      await Promise.resolve();

      const html = emailService.send.mock.calls[0]![0].html as string;
      expect(html).toContain("https://web.test/reset-password?token=");
    });

    // REG-B15: one address can belong to several businesses.
    const ORDERS: [string, UserRow[]][] = [
      ["order A,B", [ROW_A, ROW_B]],
      ["order B,A", [ROW_B, ROW_A]],
    ];

    describe("REG-B15 several businesses share one address", () => {
      it.each(ORDERS)(
        "REG-B15 reset targets the account in the resolved business (%s)",
        async (_label, rows) => {
          stubUsers(rows);

          const result = await reset("alice@example.com", "web", "t-b");
          await Promise.resolve();

          expect(result.message).toContain("If that address is registered");
          expect(createdUserIds()).toEqual(["user-b"]);
          expect(sentMails()).toHaveLength(1);
          expect(sentMails()[0]!.html).toContain("Bravo Foods");
          expect(sentMails()[0]!.html).not.toContain("Alpha Supply");
          expect(sentMails()[0]!.to).toBe("alice@example.com");
          expect((prisma.user.findMany as jest.Mock).mock.calls[0]![0].where).toEqual(
            expect.objectContaining({ tenantId: "t-b" }),
          );
        },
      );

      it.each(ORDERS)(
        "REG-B15 without a resolved business each account gets its own link naming its business (%s)",
        async (_label, rows) => {
          stubUsers(rows);

          await reset("alice@example.com", "web");
          await Promise.resolve();

          expect([...createdUserIds()].sort()).toEqual(["user-a", "user-b"]);
          expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(2);
          const mails = sentMails();
          expect(mails).toHaveLength(2);
          expect(mails.filter((m) => m.html.includes("Alpha Supply"))).toHaveLength(1);
          expect(mails.filter((m) => m.html.includes("Bravo Foods"))).toHaveLength(1);
          expect(mails.filter((m) => m.text.includes("Alpha Supply"))).toHaveLength(1);
          expect(mails.filter((m) => m.text.includes("Bravo Foods"))).toHaveLength(1);
          const arg = (prisma.user.findMany as jest.Mock).mock.calls[0]![0];
          expect(arg.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
          expect(arg.take).toBe(6);
          expect(arg.where.tenantId).toBeUndefined();
        },
      );

      it("REG-B15 more than five accounts: the first five get a link, the rest none", async () => {
        const many: UserRow[] = Array.from({ length: 7 }, (_v, i) => ({
          id: `user-${i + 1}`,
          tenantId: `t-${i + 1}`,
          email: "alice@example.com",
          createdAt: new Date(2026, 0, i + 1),
          tenant: { name: `Business ${i + 1}` },
        }));
        stubUsers(many);

        await reset("alice@example.com", "web");
        await Promise.resolve();

        expect(createdUserIds()).toEqual(["user-1", "user-2", "user-3", "user-4", "user-5"]);
        expect(sentMails()).toHaveLength(5);
      });

      it.each(ORDERS)(
        "REG-B15 an unmatched business falls back to every account with the address (%s)",
        async (_label, rows) => {
          stubUsers(rows);

          await reset("alice@example.com", "web", "t-c");
          await Promise.resolve();

          expect([...createdUserIds()].sort()).toEqual(["user-a", "user-b"]);
          expect(prisma.passwordResetToken.create).toHaveBeenCalledTimes(2);
          expect(sentMails()).toHaveLength(2);
        },
      );

      it("REG-B15 no matching account: same response, nothing written or sent", async () => {
        stubUsers([]);

        const result = await reset("nobody@example.com", "web", "t-b");
        await Promise.resolve();

        expect(result.message).toContain("If that address is registered");
        expect(prisma.passwordResetToken.deleteMany).not.toHaveBeenCalled();
        expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
        expect(emailService.send).not.toHaveBeenCalled();
      });
    });
  });

  // ── resetPassword ──────────────────────────────────────────────────────────

  describe("resetPassword", () => {
    const rawToken = "a".repeat(64);
    const fakeHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    // B791: built PER TEST. Built at collection time, its 60 s expiry would start when Jest
    // COLLECTS the file, so a slow run (a loaded host, CI) executed the tests after their own
    // fixture had expired.
    const makeBaseRecord = () => ({
      id: "prt-1",
      userId: "user-1",
      tokenHash: fakeHash,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    });
    let baseRecord: ReturnType<typeof makeBaseRecord>;
    beforeEach(() => {
      baseRecord = makeBaseRecord();
    });

    beforeEach(() => {
      mockClaimTransaction(prisma);
      (prisma.passwordResetToken.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (bcrypt.hash as jest.Mock).mockResolvedValue("$2b$10$newhash");
    });

    it("updates password when token is valid, claiming the link with its own predicate", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue(baseRecord);

      const result = await service.resetPassword(rawToken, "NewPass1!");

      expect(result.message).toContain("Password reset successfully");
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: fakeHash, usedAt: null, expiresAt: { gt: expect.any(Date) } },
        data: { usedAt: expect.any(Date) },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { password: "$2b$10$newhash", forcePasswordChange: false },
      });
    });

    it("a lost claim (count 0) writes no password and no session delete", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue(baseRecord);
      (prisma.passwordResetToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        "Reset link is invalid or has already been used.",
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
    });

    it("a non-active account is refused with the spent-link text, after the claim", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue(baseRecord);
      mockClaimTransaction(prisma, { status: "SUSPENDED", deletedAt: null });

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        "Reset link is invalid or has already been used.",
      );
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
    });

    it("throws 400 when token is not found", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resetPassword("badtoken", "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws 400 when token has already been used", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue({
        ...baseRecord,
        usedAt: new Date(Date.now() - 60_000),
      });

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws 400 when token has expired", async () => {
      (prisma.passwordResetToken.findUnique as jest.Mock).mockResolvedValue({
        ...baseRecord,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(service.resetPassword(rawToken, "NewPass1!")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
