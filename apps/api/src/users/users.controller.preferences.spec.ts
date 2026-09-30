import { listenOnLoopback } from "../common/testing/listen-loopback";
import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { LOW_STOCK_DIGEST_PREF_KEY } from "../inventory/low-stock-digest.service";

describe("PATCH/GET users/me/preferences — typed lowStockDigestEnabled", () => {
  let app: INestApplication;
  let prisma: ReturnType<typeof createMockPrisma>;
  const store = new Map<string, string>();

  beforeEach(async () => {
    store.clear();
    prisma = createMockPrisma();
    const pref = prisma.forTenant().userPreference as any;
    pref.upsert.mockImplementation(async ({ where, create, update }: any) => {
      const k = `${where.userId_key.userId}|${where.userId_key.key}`;
      store.set(k, store.has(k) ? update.value : create.value);
    });
    pref.findMany.mockImplementation(async ({ where }: any) =>
      [...store.entries()]
        .filter(([k]) => k.startsWith(`${where.userId}|`))
        .map(([k, value]) => ({ key: k.split("|")[1], value })),
    );
    const mod = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => ({}) } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { sub: "caller-1", role: "TENANT_ADMIN" };
          return true;
        },
      })
      .compile();
    app = mod.createNestApplication();
    // Same global pipe as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await listenOnLoopback(app); // #2267
  });

  afterEach(() => app.close());

  it("uses the stored key name unchanged", () => {
    expect(LOW_STOCK_DIGEST_PREF_KEY).toBe("lowStockDigestEnabled");
  });

  it.each(["true", "false"])("accepts %s, persists for the caller, GET returns it", async (v) => {
    const res = await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ [LOW_STOCK_DIGEST_PREF_KEY]: v })
      .expect(200);
    expect(res.body[LOW_STOCK_DIGEST_PREF_KEY]).toBe(v);
    expect(store.get(`caller-1|${LOW_STOCK_DIGEST_PREF_KEY}`)).toBe(v);
    const got = await request(app.getHttpServer()).get("/users/me/preferences").expect(200);
    expect(got.body[LOW_STOCK_DIGEST_PREF_KEY]).toBe(v);
  });

  it.each([["yes"], [""], [true], [false], [null], ["FALSE"], ["True"], [1]])(
    "rejects %p with 400 and writes nothing",
    async (v) => {
      await request(app.getHttpServer())
        .patch("/users/me/preferences")
        .send({ [LOW_STOCK_DIGEST_PREF_KEY]: v })
        .expect(400);
      expect(store.size).toBe(0);
    },
  );

  it("leaves other keys permissive (pushEnabled still stored as-is)", async () => {
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ pushEnabled: "false", someFutureKey: "anything" })
      .expect(200);
    expect(store.get("caller-1|pushEnabled")).toBe("false");
    expect(store.get("caller-1|someFutureKey")).toBe("anything");
  });

  it("keys the write to the JWT user, never a userId in the body", async () => {
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ [LOW_STOCK_DIGEST_PREF_KEY]: "false", userId: "victim-9" })
      .expect(200);
    expect([...store.keys()].every((k) => k.startsWith("caller-1|"))).toBe(true);
    expect(store.has(`victim-9|${LOW_STOCK_DIGEST_PREF_KEY}`)).toBe(false);
  });
});
