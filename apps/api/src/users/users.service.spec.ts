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

  // ─── Cross-tenant fallback lookups (B213 follow-up) ────────────────────────
  //
  // These used to filter `status: "ACTIVE"` in the query itself, so an INACTIVE
  // self-signup user (pending email verification) whose typed/cached workspace
  // slug didn't match their own tenant was invisible to auth.service.ts's
  // validateUser() BEFORE it ever got a chance to check the password or return
  // its distinguishable EMAIL_NOT_VERIFIED error — status filtering belongs
  // there now, after the credential is verified, not in this lookup.
  describe("findByEmailCrossTenant", () => {
    it("returns an INACTIVE user (not filtered out) when the email is globally unique", async () => {
      const inactiveUser = { id: "u1", email: "new@acme.example", status: "INACTIVE" };
      prisma.user.findMany.mockResolvedValue([inactiveUser] as any);

      const result = await service.findByEmailCrossTenant("new@acme.example");

      expect(result).toEqual(inactiveUser);
      const call = prisma.user.findMany.mock.calls[0][0] as any;
      expect(call.where).not.toHaveProperty("status");
      expect(call.where.deletedAt).toBeNull();
    });

    it("still returns null when 0 or 2+ matches (ambiguous), regardless of status", async () => {
      prisma.user.findMany.mockResolvedValue([]);
      expect(await service.findByEmailCrossTenant("nobody@nowhere.example")).toBeNull();

      prisma.user.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }] as any);
      expect(await service.findByEmailCrossTenant("shared@example.com")).toBeNull();
    });
  });

  describe("findByUsernameCrossTenant", () => {
    it("returns an INACTIVE user (not filtered out) when the username is globally unique", async () => {
      const inactiveUser = { id: "u2", username: "acme_admin", status: "INACTIVE" };
      prisma.user.findMany.mockResolvedValue([inactiveUser] as any);

      const result = await service.findByUsernameCrossTenant("acme_admin");

      expect(result).toEqual(inactiveUser);
      const call = prisma.user.findMany.mock.calls[0][0] as any;
      expect(call.where).not.toHaveProperty("status");
    });
  });
});
