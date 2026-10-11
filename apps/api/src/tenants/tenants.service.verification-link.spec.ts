import * as crypto from "crypto";
import { TenantsService } from "./tenants.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  EMAIL_VERIFY_LIVE_TOKENS_KEPT,
  EMAIL_VERIFY_TOKEN_TTL_MS,
  hashEmailVerifyToken,
} from "../auth/email-verification-token";
import { VERIFY_RESEND_CUTOFF } from "../auth/legacy-link-windows";

/**
 * The verification link a signup admin is emailed: a stored single-use token in the URL
 * fragment. The resend keeps the newest two live tokens, and never issues one for an account
 * created before the issue cut-off (those owners stay on the back-office path).
 */
type TokenRow = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

function tokenTable() {
  const rows: TokenRow[] = [];
  let seq = 0;
  let clock = Date.parse("2026-10-12T12:00:00.000Z");
  return {
    rows,
    create: jest.fn(async ({ data }: any) => {
      const row: TokenRow = {
        id: `evt-${++seq}`,
        usedAt: null,
        createdAt: new Date((clock += 1000)),
        ...data,
      };
      rows.push(row);
      return { id: row.id };
    }),
    findMany: jest.fn(async ({ where }: any) =>
      rows
        .filter(
          (r) =>
            r.userId === where.userId &&
            r.usedAt === null &&
            r.expiresAt > where.expiresAt.gt &&
            r.id !== where.id.not,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => ({ id: r.id })),
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter(
        (r) => where.id.in.includes(r.id) && r.userId === where.userId && r.usedAt === null,
      );
      for (const r of hit) r.usedAt = data.usedAt;
      return { count: hit.length };
    }),
  };
}

const owner = (over: Record<string, unknown> = {}) => ({
  id: "user-1",
  email: "owner@acme.example",
  username: "acme_admin",
  role: "TENANT_ADMIN",
  status: "INACTIVE",
  lastLoginAt: null,
  deletedAt: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  tenant: { id: "tenant-1", name: "Acme", slug: "acme" },
  ...over,
});

describe("TenantsService — stored verification links", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let table: ReturnType<typeof tokenTable>;
  let email: { send: jest.Mock };
  let service: TenantsService;

  beforeEach(() => {
    prisma = createMockPrisma();
    table = tokenTable();
    (prisma as any).userEmailVerificationToken = table;
    (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ userEmailVerificationToken: table }),
    );
    (prisma.refreshToken.count as jest.Mock).mockResolvedValue(0);
    email = { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) };
    const limiter = {
      increment: jest.fn().mockResolvedValue({
        totalHits: 1,
        timeToExpire: 1,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    };
    const config = {
      get: jest.fn((k: string) =>
        k === "urls" ? { web: "https://web.test/", mobileWeb: "https://m.test" } : undefined,
      ),
    };
    service = new TenantsService(
      prisma as any,
      {} as any,
      {} as any,
      email as any,
      config as any,
      limiter as any,
    );
  });

  const emailedToken = (call = 0): string => {
    const html: string = email.send.mock.calls[call][0].html;
    return html.match(/verify-email#t=([\w-]+)/)![1]!;
  };

  it("a resend emails a fragment link whose token is stored only as its SHA-256", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(owner());

    expect(await service.performResend("owner@acme.example")).toBe(true);

    const html: string = email.send.mock.calls[0][0].html;
    expect(html).toContain("https://web.test/verify-email#t=");
    expect(html).not.toContain("?token=");
    const token = emailedToken();
    expect(token).toHaveLength(43);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.tokenHash).toBe(hashEmailVerifyToken(token));
    expect(table.rows[0]!.tokenHash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(table.rows)).not.toContain(token);
    expect(table.rows[0]!.userId).toBe("user-1");
  });

  it("the token lives exactly as long as the signed link did (24h)", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(owner());
    const before = Date.now();

    await service.performResend("owner@acme.example");

    const ttl = table.rows[0]!.expiresAt.getTime() - before;
    expect(EMAIL_VERIFY_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(ttl).toBeGreaterThanOrEqual(EMAIL_VERIFY_TOKEN_TTL_MS);
    expect(ttl).toBeLessThan(EMAIL_VERIFY_TOKEN_TTL_MS + 5000);
  });

  it("keeps the newest two live tokens and burns the older ones in the same transaction", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(owner());

    for (let i = 0; i < 4; i++) await service.performResend("owner@acme.example");

    expect(EMAIL_VERIFY_LIVE_TOKENS_KEPT).toBe(2);
    const live = table.rows.filter((r) => r.usedAt === null).map((r) => r.id);
    expect(live).toEqual(["evt-3", "evt-4"]);
    // the older two were burned, not deleted
    expect(table.rows.map((r) => r.usedAt !== null)).toEqual([true, true, false, false]);
    expect((prisma.$transaction as jest.Mock).mock.calls).toHaveLength(4);
  });

  it("a pre-cutoff owner's resend issues nothing, with the same silent outcome", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(
      owner({ createdAt: new Date(VERIFY_RESEND_CUTOFF.getTime() - 1) }),
    );

    expect(await service.performResend("owner@acme.example")).toBe(false);

    expect(table.create).not.toHaveBeenCalled();
    expect(table.rows).toHaveLength(0);
    expect(email.send).not.toHaveBeenCalled();
    // the public entry point answers the same (undefined) as for an eligible owner
    await expect(service.resendVerification("owner@acme.example")).resolves.toBeUndefined();
  });

  it("an owner created exactly at the cutoff is eligible", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(
      owner({ createdAt: new Date(VERIFY_RESEND_CUTOFF.getTime()) }),
    );

    expect(await service.performResend("owner@acme.example")).toBe(true);
    expect(table.rows).toHaveLength(1);
  });

  it("an ineligible account (signed in before, holds a session) is issued nothing", async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(owner());
    (prisma.refreshToken.count as jest.Mock).mockResolvedValue(1);

    expect(await service.performResend("owner@acme.example")).toBe(false);

    expect(table.rows).toHaveLength(0);
    expect(email.send).not.toHaveBeenCalled();
  });
});
