import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { SettingsController } from "./settings.controller";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("SettingsController — PATCH/GET /settings/route depot", () => {
  let controller: SettingsController;
  let store: Record<string, string>;
  let svc: { get: jest.Mock; set: jest.Mock };

  beforeEach(async () => {
    store = {};
    svc = {
      get: jest.fn(async (k: string) => store[k] ?? null),
      set: jest.fn(async (k: string, v: string) => {
        store[k] = v;
      }),
    };
    const prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: svc },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    controller = module.get<SettingsController>(SettingsController);
  });

  it("persists both depot keys and GET round-trips the numbers", async () => {
    const res = await controller.updateRouteSettings({ depotLat: 40.7128, depotLng: -74.006 });
    expect(svc.set).toHaveBeenCalledWith("route.defaultDepotLat", "40.7128");
    expect(svc.set).toHaveBeenCalledWith("route.defaultDepotLng", "-74.006");
    expect(res.depotLat).toBe(40.7128);
    expect(res.depotLng).toBe(-74.006);
    const got = await controller.getRouteSettings();
    expect(got.depotLat).toBe(40.7128);
    expect(got.depotLng).toBe(-74.006);
  });

  it("accepts the 0/0 boundary values (falsy but valid)", async () => {
    const res = await controller.updateRouteSettings({ depotLat: 0, depotLng: 0 });
    expect(res.depotLat).toBe(0);
    expect(res.depotLng).toBe(0);
  });

  it("rejects lat without lng and lng without lat, writing nothing", async () => {
    await expect(controller.updateRouteSettings({ depotLat: 10 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.updateRouteSettings({ depotLng: 10 })).rejects.toThrow(
      BadRequestException,
    );
    expect(svc.set).not.toHaveBeenCalled();
  });

  it("leaves depot untouched when neither is sent", async () => {
    await controller.updateRouteSettings({ serviceTimeMinutes: 20 });
    expect(svc.set).toHaveBeenCalledTimes(1);
    expect(svc.set).toHaveBeenCalledWith("route.serviceTimeMinutes", "20");
  });

  it("role pin: PATCH route stays OPERATOR-only", () => {
    const roles = Reflect.getMetadata("roles", SettingsController.prototype.updateRouteSettings);
    const classRoles = Reflect.getMetadata("roles", SettingsController);
    expect(roles ?? classRoles).toEqual(["OPERATOR"]);
  });
});

describe("SettingsController — PATCH /settings/route over HTTP (real RolesGuard)", () => {
  let app: INestApplication;
  let role = "OPERATOR";
  const svc = { get: jest.fn(async () => null), set: jest.fn(async () => undefined) };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SystemConfigService, useValue: svc },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { sub: "u-1", role };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await listenOnLoopback(app);
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it.each(["DRIVER", "CUSTOMER"])("%s is refused with 403 and nothing is written", async (r) => {
    role = r;
    await request(app.getHttpServer())
      .patch("/settings/route")
      .send({ serviceTimeMinutes: 20 })
      .expect(403);
    expect(svc.set).not.toHaveBeenCalled();
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s can save route defaults", async (r) => {
    role = r;
    await request(app.getHttpServer())
      .patch("/settings/route")
      .send({ serviceTimeMinutes: 20 })
      .expect(200);
    expect(svc.set).toHaveBeenCalledWith("route.serviceTimeMinutes", "20");
  });
});
