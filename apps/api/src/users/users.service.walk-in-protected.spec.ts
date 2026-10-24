/**
 * The walk-in customer's login account keeps working for counter sales: its status cannot be changed and its
 * password cannot be reset through the user-management entry points. Both refuse with the coded
 * WALK_IN_PROTECTED error before anything is written or sent. Other users behave as before.
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

const USER = (id: string, role = "CUSTOMER") => ({
  id,
  username: `u-${id}`,
  email: `${id}@acme.example`,
  role,
  status: "ACTIVE",
  deletedAt: null,
});

describe("UsersService: the walk-in customer's account is protected", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let email: Record<string, jest.Mock>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    email = { sendSetPasswordEmail: jest.fn().mockResolvedValue({ delivered: true }) };
    const mod = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: { get: () => ({ web: "https://a.example" }) } },
      ],
    }).compile();
    service = mod.get(UsersService);
  });

  const linkCustomer = (isWalkIn: boolean | null) =>
    prisma.customer.findFirst.mockImplementation((async (args: any) =>
      args?.where?.userId === "u-walk" || args?.where?.userId === "u-cust"
        ? { id: "c1", userId: args.where.userId, isWalkIn }
        : null) as any);

  const protectedError = async (p: Promise<unknown>) => {
    const e: any = await p.then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ code: "WALK_IN_PROTECTED" });
  };

  it.each(["SUSPENDED", "INACTIVE"])(
    "the walk-in customer's account cannot be set to %s",
    async (status) => {
      prisma.user.findUnique.mockResolvedValue(USER("u-walk") as any);
      linkCustomer(true);
      await protectedError(
        service.changeStatus("u-walk", { status } as any, "TENANT_ADMIN" as any),
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it("the walk-in customer's password cannot be reset: no write, no email", async () => {
    prisma.user.findUnique.mockResolvedValue(USER("u-walk") as any);
    linkCustomer(true);
    await protectedError(service.resetPassword("u-walk", "TENANT_ADMIN" as any));
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(email.sendSetPasswordEmail).not.toHaveBeenCalled();
  });

  it("an ordinary customer's account still changes status and resets its password", async () => {
    prisma.user.findUnique.mockResolvedValue(USER("u-cust") as any);
    prisma.user.update.mockResolvedValue({ id: "u-cust" } as any);
    linkCustomer(null);
    await expect(
      service.changeStatus("u-cust", { status: "SUSPENDED" } as any, "TENANT_ADMIN" as any),
    ).resolves.toBeDefined();
    await expect(service.resetPassword("u-cust", "TENANT_ADMIN" as any)).resolves.toHaveProperty(
      "tempPassword",
    );
  });

  it("a staff user (no linked customer) still changes status and resets its password", async () => {
    prisma.user.findUnique.mockResolvedValue(USER("u-staff", "OPERATOR") as any);
    prisma.user.update.mockResolvedValue({ id: "u-staff" } as any);
    prisma.customer.findFirst.mockResolvedValue(null as any);
    await expect(
      service.changeStatus("u-staff", { status: "SUSPENDED" } as any, "TENANT_ADMIN" as any),
    ).resolves.toBeDefined();
    await expect(service.resetPassword("u-staff", "TENANT_ADMIN" as any)).resolves.toHaveProperty(
      "tempPassword",
    );
  });
});
