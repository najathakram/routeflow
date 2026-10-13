/**
 * SA Perms PR1 M2: a status change can never lock a workspace out of account administration. Deactivating
 * (INACTIVE or SUSPENDED) yourself is refused, and so is deactivating the LAST active TENANT_ADMIN. Both are a
 * coded 409; the active-admin rows are read FOR UPDATE inside the write's transaction, so two admins
 * deactivating each other at once cannot both pass.
 */
import { ConflictException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

const admin = (id: string) => ({
  id,
  username: id,
  email: `${id}@acme.example`,
  role: "TENANT_ADMIN",
  status: "ACTIVE",
  deletedAt: null,
});
const operator = (id: string) => ({ ...admin(id), role: "OPERATOR" });

describe("UsersService.changeStatus: no lockout (SA M2)", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let activeAdmins: { id: string }[];
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    activeAdmins = [];
    queryRaw = jest.fn(async () => activeAdmins);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...prisma.forTenant(), $queryRaw: queryRaw, $executeRaw: jest.fn() }),
    );
    prisma.user.update.mockImplementation(async ({ where, data }: any) => ({
      id: where.id,
      ...data,
    }));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => ({}) } },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      return ((e as ConflictException).getResponse() as { code?: string }).code;
    }
  };

  it.each(["INACTIVE", "SUSPENDED"])(
    "deactivating YOURSELF (%s) is a coded 409, nothing written",
    async (status) => {
      prisma.user.findUnique.mockResolvedValue(admin("me"));
      activeAdmins = [{ id: "me" }, { id: "other" }];
      expect(
        await codeOf(service.changeStatus("me", { status } as any, UserRole.TENANT_ADMIN, "me")),
      ).toBe(API_ERROR_CODES.SELF_DEACTIVATION_REFUSED);
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it("deactivating the LAST active tenant admin is a coded 409, nothing written", async () => {
    prisma.user.findUnique.mockResolvedValue(admin("a1"));
    activeAdmins = [{ id: "a1" }];
    expect(
      await codeOf(
        service.changeStatus("a1", { status: "SUSPENDED" } as any, UserRole.TENANT_ADMIN, "a2"),
      ),
    ).toBe(API_ERROR_CODES.LAST_TENANT_ADMIN);
    expect(prisma.user.update).not.toHaveBeenCalled();
    // the active admins are read with a row lock inside the write's transaction
    const sql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/TENANT_ADMIN/);
  });

  it("another active admin remains: the deactivation goes through", async () => {
    prisma.user.findUnique.mockResolvedValue(admin("a1"));
    activeAdmins = [{ id: "a1" }, { id: "a2" }];
    await expect(
      service.changeStatus("a1", { status: "SUSPENDED" } as any, UserRole.TENANT_ADMIN, "a2"),
    ).resolves.toMatchObject({
      id: "a1",
      status: "SUSPENDED",
    });
  });

  it("deactivating an operator, or re-activating anyone, never needs another admin", async () => {
    prisma.user.findUnique.mockResolvedValue(operator("o1"));
    activeAdmins = [{ id: "a1" }];
    await expect(
      service.changeStatus("o1", { status: "INACTIVE" } as any, UserRole.TENANT_ADMIN, "a1"),
    ).resolves.toBeTruthy();
    prisma.user.findUnique.mockResolvedValue({ ...admin("a9"), status: "SUSPENDED" });
    activeAdmins = [];
    await expect(
      service.changeStatus("a9", { status: "ACTIVE" } as any, UserRole.TENANT_ADMIN, "a1"),
    ).resolves.toBeTruthy();
  });
});
