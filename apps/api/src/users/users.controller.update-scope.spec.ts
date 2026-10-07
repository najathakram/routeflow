/**
 * Operator permissions PR1 + SA-726 M5: who may edit a user record, and what an edit can write.
 *
 *  - another user's record is account administration: TENANT_ADMIN only
 *  - anyone may edit their OWN record (email / username), and a self edit never carries a role
 *  - `updateUser` writes an explicit pick of columns, never a spread of the body, so no field a caller
 *    smuggles onto the DTO (permissions, status, driver capacity, tenant) reaches the database
 */
import "reflect-metadata";
import { ForbiddenException, ValidationPipe, BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { ConfigService } from "@nestjs/config";
import { createMockPrisma } from "../testing/prisma-mock";

describe("UsersController.update: who may edit whom", () => {
  const service = { updateUser: jest.fn().mockResolvedValue({ id: "x" }) };
  const controller = new UsersController(service as never);
  const operator = { sub: "op1", username: "op", role: UserRole.OPERATOR } as never;
  const admin = { sub: "ad1", username: "ad", role: UserRole.TENANT_ADMIN } as never;
  const driver = { sub: "dr1", username: "dr", role: UserRole.DRIVER } as never;
  beforeEach(() => jest.clearAllMocks());

  it("an OPERATOR editing ANOTHER user is refused, and nothing is written", () => {
    expect(() => controller.update("someone-else", { email: "a@b.example" }, operator)).toThrow(
      ForbiddenException,
    );
    expect(service.updateUser).not.toHaveBeenCalled();
  });

  it("an OPERATOR editing their OWN record is allowed, with the role always stripped", async () => {
    await controller.update("op1", { email: "a@b.example", role: UserRole.TENANT_ADMIN }, operator);
    expect(service.updateUser).toHaveBeenCalledWith(
      "op1",
      { email: "a@b.example", role: undefined },
      "op",
      UserRole.OPERATOR,
    );
  });

  it("a TENANT_ADMIN may edit another user, and only then may a role ride along", async () => {
    await controller.update("someone-else", { role: UserRole.DRIVER }, admin);
    expect(service.updateUser).toHaveBeenLastCalledWith(
      "someone-else",
      { role: UserRole.DRIVER },
      "ad",
      UserRole.TENANT_ADMIN,
    );
  });

  it("an admin's own edit strips the role too (nobody changes their own role)", async () => {
    await controller.update("ad1", { role: UserRole.DRIVER }, admin);
    expect(service.updateUser).toHaveBeenLastCalledWith(
      "ad1",
      { role: undefined },
      "ad",
      UserRole.TENANT_ADMIN,
    );
  });

  it("RF-073 stays closed: a driver editing their own record cannot self-promote; another user is refused", async () => {
    await controller.update("dr1", { role: UserRole.OPERATOR }, driver);
    expect(service.updateUser).toHaveBeenLastCalledWith(
      "dr1",
      { role: undefined },
      "dr",
      UserRole.DRIVER,
    );
    expect(() => controller.update("other", { email: "a@b.example" }, driver)).toThrow(
      ForbiddenException,
    );
  });
});

describe("PATCH /users/:id body (SA-726 M5)", () => {
  // The same pipe options main.ts installs globally.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
  const run = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: "body", metatype: UpdateUserDto });

  it.each([
    ["deniedPermissionGroups", []],
    ["permissionsVersion", 1],
    ["canActAsDriver", true],
    ["status", "ACTIVE"],
    ["tenantId", "other-tenant"],
    ["isAdmin", true],
    ["password", "x"],
  ])("a body carrying %s is a 400", async (field, value) => {
    await expect(run({ [field]: value })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the three real fields pass", async () => {
    await expect(run({ email: "a@b.example", username: "someone" })).resolves.toBeTruthy();
    await expect(run({ role: UserRole.DRIVER })).resolves.toBeTruthy();
  });
});

describe("UsersService.updateUser writes an explicit pick (SA-726 M5)", () => {
  const stored = {
    id: "u1",
    role: UserRole.OPERATOR,
    email: "old@b.example",
    username: "old",
    status: "ACTIVE",
  };
  let prisma: ReturnType<typeof createMockPrisma>;
  let update: jest.Mock;
  let service: UsersService;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.user.findUnique.mockResolvedValue(stored as never);
    update = prisma.user.update;
    update.mockResolvedValue({ ...stored, id: "u1" });
    (prisma as unknown as { passwordResetToken: { updateMany: jest.Mock } }).passwordResetToken = {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EmailService,
          useValue: {
            sendEmailChangedNotice: jest.fn().mockResolvedValue({ delivered: true }),
            sendEmailChangeConfirmation: jest.fn().mockResolvedValue({ delivered: true }),
            send: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = module.get(UsersService);
  });

  it.each([
    ["deniedPermissionGroups", []],
    ["permissionsVersion", 7],
    ["canActAsDriver", true],
    ["status", "SUSPENDED"],
    ["tenantId", "other-tenant"],
    ["isAdmin", true],
  ])("a %s smuggled onto the DTO is never written", async (field, value) => {
    await service.updateUser(
      "u1",
      { email: "new@b.example", [field]: value } as never,
      "admin",
      UserRole.TENANT_ADMIN,
    );
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["email"]);
    expect(data).not.toHaveProperty(field);
  });

  it("only role, email and username can be written, and only when they change or are sent", async () => {
    await service.updateUser(
      "u1",
      { email: "new@b.example", username: "newname", role: UserRole.DRIVER },
      "admin",
      UserRole.TENANT_ADMIN,
    );
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["email", "role", "username"]);
  });
});
