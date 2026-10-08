/**
 * The walk-in customer's login account keeps its email, username and role: updateUser refuses a CHANGE of
 * any of them with the coded WALK_IN_PROTECTED error before anything is written. Values resent unchanged by
 * an edit form, other fields, and ordinary users behave as before.
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { UsersService } from "./users.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

const STORED = (id: string) => ({
  id,
  username: `u-${id}`,
  email: `${id}@acme.example`,
  role: "OPERATOR",
  status: "ACTIVE",
  deletedAt: null,
});

describe("UsersService.updateUser: the walk-in customer's account identity stays fixed", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EmailService,
          useValue: { sendSetPasswordEmail: jest.fn().mockResolvedValue({ delivered: true }) },
        },
        { provide: ConfigService, useValue: { get: () => ({ web: "https://a.example" }) } },
      ],
    }).compile();
    service = mod.get(UsersService);
    prisma.user.update.mockResolvedValue({ id: "x" } as any);
  });

  const linkCustomer = (userId: string, isWalkIn: boolean | null) =>
    prisma.customer.findFirst.mockImplementation((async (args: any) =>
      args?.where?.userId === userId ? { id: "c1", userId, isWalkIn } : null) as any);

  const run = (id: string, dto: Record<string, unknown>) =>
    service.updateUser(id, dto as any, "admin", "TENANT_ADMIN" as any);

  it.each([
    ["email", { email: "other@acme.example" }],
    ["username", { username: "renamed" }],
    ["role", { role: "DRIVER" }],
  ])("refuses a changed %s on the walk-in account and writes nothing", async (_n, dto) => {
    prisma.user.findUnique.mockResolvedValue(STORED("walk") as any);
    linkCustomer("walk", true);

    const e: any = await run("walk", dto).then(
      () => null,
      (err) => err,
    );

    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ code: "WALK_IN_PROTECTED" });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("lets the walk-in account through when the edit form resends the same values", async () => {
    prisma.user.findUnique.mockResolvedValue(STORED("walk") as any);
    linkCustomer("walk", true);

    await run("walk", { email: "walk@acme.example", username: "u-walk", role: "OPERATOR" });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("lets an ordinary user's email change through", async () => {
    prisma.user.findUnique.mockResolvedValue(STORED("ord") as any);
    linkCustomer("ord", false);

    await run("ord", { email: "new@acme.example" });

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
});
