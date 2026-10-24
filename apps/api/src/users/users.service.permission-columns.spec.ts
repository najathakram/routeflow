/**
 * The per-operator feature-group columns on User: reported by the admin listing only, never by any
 * other user read, and never accepted from the update body.
 */
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { UsersService } from "./users.service";
import { UpdateUserDto } from "./dto/update-user.dto";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

const COLUMNS = ["deniedPermissionGroups", "permissionsVersion"] as const;

describe("UsersService: feature-group columns", () => {
  let service: UsersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => ({}) } },
      ],
    }).compile();
    service = mod.get(UsersService);
  });

  const selectOfListing = (): Record<string, unknown> =>
    (prisma.user.findMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;

  describe("findAll", () => {
    it.each([UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN])(
      "selects both columns for a %s caller",
      async (role) => {
        await service.findAll({}, role);
        for (const col of COLUMNS) expect(selectOfListing()[col]).toBe(true);
      },
    );

    it.each([UserRole.OPERATOR, UserRole.DRIVER, undefined])(
      "selects neither column for a %s caller",
      async (role) => {
        await service.findAll({}, role);
        for (const col of COLUMNS) expect(selectOfListing()).not.toHaveProperty(col);
      },
    );

    it("never selects the password hash", async () => {
      await service.findAll({}, UserRole.TENANT_ADMIN);
      expect(selectOfListing()).not.toHaveProperty("password");
    });
  });

  describe("findById (GET /users/me and GET /users/:id)", () => {
    it("drops the feature-group columns, the password hash and the Google id from the row", async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        username: "op",
        email: "op@example.com",
        role: "OPERATOR",
        password: "hash",
        googleId: "g-1",
        deniedPermissionGroups: ["FINANCE"],
        permissionsVersion: 3,
      });
      const out = await service.findById("u1");
      expect(out).toMatchObject({ id: "u1", googleLinked: true, hasPassword: true });
      for (const col of [...COLUMNS, "password", "googleId"]) expect(out).not.toHaveProperty(col);
    });
  });
});

describe("UpdateUserDto whitelist", () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  });
  const run = (body: object) =>
    pipe.transform(body, { type: "body", metatype: UpdateUserDto, data: "" });

  it.each([
    [{ deniedPermissionGroups: [] }],
    [{ deniedPermissionGroups: ["FINANCE"] }],
    [{ permissionsVersion: 1 }],
    [{ email: "a@example.com", permissionsVersion: 99 }],
  ])("PATCH /users/:id with %j is rejected (400), never passed on", async (body) => {
    await expect(run(body)).rejects.toMatchObject({ status: 400 });
  });

  it("an ordinary profile edit still validates", async () => {
    await expect(run({ email: "a@example.com", username: "a" })).resolves.toMatchObject({
      email: "a@example.com",
    });
  });
});
