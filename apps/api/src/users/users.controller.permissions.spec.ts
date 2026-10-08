import { listenOnLoopback } from "../common/testing/listen-loopback";
import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OperatorPermissionGroup } from "@prisma/client";
import request from "supertest";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { OperatorPermissionsService } from "../auth/permissions/operator-permissions.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const ALL = Object.values(OperatorPermissionGroup);

describe("GET /users/me/permissions", () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createMockPrisma>;
  let caller: Record<string, unknown>;
  const findById = jest.fn();

  beforeEach(async () => {
    prisma = createMockPrisma();
    findById.mockReset().mockResolvedValue({ id: "from-:id-route" });
    caller = { sub: "op1", username: "op", role: "OPERATOR", tenantId: "t1" };
    const mod = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        OperatorPermissionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: UsersService, useValue: { findById } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = caller;
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });

  afterEach(() => app.close());

  it("an operator with no denied groups gets all 9 groups and is not an account admin", async () => {
    prisma.user.findFirst.mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 0 });
    const res = await request(app.getHttpServer()).get("/users/me/permissions").expect(200);
    expect(res.body).toEqual({
      role: "OPERATOR",
      isAccountAdmin: false,
      groups: ALL,
      version: 0,
      mode: "shadow",
    });
    expect(res.body.groups).toHaveLength(9);
  });

  it("an operator whose token carries a legacy isAdmin flag is still not an account admin", async () => {
    caller = { ...caller, isAdmin: true };
    prisma.user.findFirst.mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 0 });
    const res = await request(app.getHttpServer()).get("/users/me/permissions").expect(200);
    expect(res.body.isAccountAdmin).toBe(false);
    expect(res.body.role).toBe("OPERATOR");
  });

  it("an operator with denied groups gets the rest, and the stored version", async () => {
    prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: ["FINANCE", "PRICING"],
      permissionsVersion: 4,
    });
    const res = await request(app.getHttpServer()).get("/users/me/permissions").expect(200);
    expect(res.body.groups).toEqual(ALL.filter((g) => g !== "FINANCE" && g !== "PRICING"));
    expect(res.body.version).toBe(4);
    expect(res.body.isAccountAdmin).toBe(false);
  });

  it("the account admin gets all 9 groups and isAccountAdmin true, with no user read", async () => {
    caller = { sub: "ad1", username: "ad", role: "TENANT_ADMIN", tenantId: "t1" };
    const res = await request(app.getHttpServer()).get("/users/me/permissions").expect(200);
    expect(res.body).toEqual({
      role: "TENANT_ADMIN",
      isAccountAdmin: true,
      groups: ALL,
      version: 0,
      mode: "shadow",
    });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("a driver gets no groups and is not an account admin", async () => {
    caller = { sub: "d1", username: "dr", role: "DRIVER", tenantId: "t1" };
    const res = await request(app.getHttpServer()).get("/users/me/permissions").expect(200);
    expect(res.body).toEqual({
      role: "DRIVER",
      isAccountAdmin: false,
      groups: [],
      version: 0,
      mode: "shadow",
    });
  });

  it("is not shadowed by the :id route (the :id handler is never reached)", async () => {
    prisma.user.findFirst.mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 0 });
    await request(app.getHttpServer()).get("/users/me/permissions").expect(200);
    expect(findById).not.toHaveBeenCalled();
  });

  it("is declared before the :id routes and is guarded by JwtAuthGuard only (any authenticated role)", () => {
    const names = Object.getOwnPropertyNames(UsersController.prototype);
    expect(names.indexOf("getMyPermissions")).toBeGreaterThan(-1);
    expect(names.indexOf("getMyPermissions")).toBeLessThan(names.indexOf("findOne"));
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, UsersController) ?? [];
    expect(classGuards).toContain(JwtAuthGuard);
    const methodGuards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, UsersController.prototype.getMyPermissions) ?? [];
    expect(methodGuards).not.toContain(RolesGuard);
  });
});
