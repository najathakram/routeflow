/**
 * users.service.spec.ts
 * ─────────────────────
 * Unit tests for UsersService.findAll — verifies that the method returns
 * { data, meta } (the paginated shape that the mobile Settings → Users tab
 * expects), not a bare array. Regression guard for NEW-vop-3.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_USERS = [
  {
    id: "user-1",
    username: "admin",
    email: "admin@example.com",
    role: "OPERATOR",
    status: "ACTIVE",
    forcePasswordChange: false,
    isAdmin: true,
    canActAsDriver: false,
    createdAt: new Date("2026-01-01"),
  },
  {
    id: "user-2",
    username: "driver_tom",
    email: "tom@example.com",
    role: "DRIVER",
    status: "ACTIVE",
    forcePasswordChange: false,
    isAdmin: false,
    canActAsDriver: true,
    createdAt: new Date("2026-01-02"),
  },
];

describe("UsersService", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe("findAll", () => {
    it("returns { data, meta } — not a bare array", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(2);

      const result = await service.findAll({});

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("meta");
      expect(Array.isArray(result.data)).toBe(true);
    });

    it("data array contains the users returned by prisma", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(2);

      const result = await service.findAll({});

      expect(result.data).toHaveLength(2);
      expect(result.data[0].username).toBe("admin");
    });

    it("meta.total reflects the prisma count", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(2);

      const result = await service.findAll({});

      expect(result.meta.total).toBe(2);
    });

    it("meta.totalPages is ceil(total / limit)", async () => {
      // 5 users, limit=2 → 3 pages
      prisma.forTenant().user.findMany.mockResolvedValue(MOCK_USERS as any);
      prisma.forTenant().user.count.mockResolvedValue(5);

      const result = await service.findAll({ limit: 2 });

      expect(result.meta.totalPages).toBe(3);
    });

    it("passes skip correctly for page 2", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue([]);
      prisma.forTenant().user.count.mockResolvedValue(0);

      await service.findAll({ page: 2, limit: 10 });

      const findManyCall = prisma.forTenant().user.findMany.mock.calls[0][0] as any;
      expect(findManyCall.skip).toBe(10);
    });

    it("excludes CUSTOMER role from the query", async () => {
      prisma.forTenant().user.findMany.mockResolvedValue([]);
      prisma.forTenant().user.count.mockResolvedValue(0);

      await service.findAll({});

      const findManyCall = prisma.forTenant().user.findMany.mock.calls[0][0] as any;
      expect(findManyCall.where?.role).toEqual({ not: "CUSTOMER" });
    });
  });

  // ─── Cross-tenant fallback lookups ──────────────────────────────────────────
  //
  // Regression coverage (review of PR #778): an earlier version of this fix
  // dropped `status: "ACTIVE"` from these queries so an INACTIVE self-signup
  // user could reach a distinguishable EMAIL_NOT_VERIFIED error in
  // auth.service.ts's validateUser(). That signal was reverted (UserStatus
  // has no column distinguishing "never verified" from "an admin deactivated
  // this account," so it can't be surfaced safely — see auth.service.spec.ts),
  // so there is no longer any reason to widen this lookup past ACTIVE. Kept
  // filtered: an ACTIVE user whose email also exists on a deactivated account
  // in another tenant must resolve to exactly one match, not two.
  describe("findByEmailCrossTenant", () => {
    it("filters to status:ACTIVE — a deactivated account with the same email in another tenant must not create a false ambiguity", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: "u1", email: "owner@acme.example" }] as any);

      const result = await service.findByEmailCrossTenant("owner@acme.example");

      expect(result).toEqual({ id: "u1", email: "owner@acme.example" });
      const call = prisma.user.findMany.mock.calls[0][0] as any;
      expect(call.where).toMatchObject({ status: "ACTIVE", deletedAt: null });
    });

    it("returns null when 0 or 2+ ACTIVE matches (ambiguous)", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      expect(await service.findByEmailCrossTenant("nobody@nowhere.example")).toBeNull();

      prisma.user.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }] as any);
      expect(await service.findByEmailCrossTenant("shared@example.com")).toBeNull();
    });
  });

  describe("findByUsernameCrossTenant", () => {
    it("filters to status:ACTIVE", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: "u2", username: "acme_admin" }] as any);

      const result = await service.findByUsernameCrossTenant("acme_admin");

      expect(result).toEqual({ id: "u2", username: "acme_admin" });
      const call = prisma.user.findMany.mock.calls[0][0] as any;
      expect(call.where).toMatchObject({ status: "ACTIVE" });
    });
  });
});
