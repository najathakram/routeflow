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
import { OperatorPermissionsService } from "../auth/permissions/operator-permissions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { PREF, PREFERENCE_KEYS as SHARED_KEYS, type PreferenceKey } from "@routeflow/types";
import { getMetadataStorage } from "class-validator";
import { PREFERENCE_KEYS, UpdatePreferencesDto } from "./dto/update-preferences.dto";
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
        { provide: OperatorPermissionsService, useValue: {} },
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

  // One valid sample per shared key. `Record<PreferenceKey, string>` makes a key added to
  // `@routeflow/types` without a sample here a compile error; clients write through `PREF.*`
  // and `PreferencePatch`, so the shared list IS the real client key set.
  const CLIENT_KEYS: Record<PreferenceKey, string> = {
    lowStockDigestEnabled: "false",
    pushEnabled: "false",
    staffOrderEmail: "false",
    staffBuyerChangeEmail: "false",
    locale: "es",
    "bill.lastSupplierId": "sup-123",
    "payment.lastMethod": "ACH",
    "orders.posMode": "true",
  };

  it("the api allow-list is the shared client key list", () => {
    expect([...PREFERENCE_KEYS].sort()).toEqual([...SHARED_KEYS].sort());
    expect([...PREFERENCE_KEYS].sort()).toEqual(Object.keys(CLIENT_KEYS).sort());
    expect([...PREFERENCE_KEYS].sort()).toEqual(Object.values(PREF).sort());
  });

  it("apps/mobile's jest stub of @routeflow/types carries the same PREF (it is hand-copied)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require("../../../mobile/__tests__/__mocks__/@routeflow/types.js") as Record<
      string,
      unknown
    >;
    expect(stub.PREF).toEqual(PREF);
  });

  it("every shared client key has a validator in the DTO (none falls through unvalidated)", () => {
    const validated = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(UpdatePreferencesDto, "", false, false)
        .map((m) => m.propertyName),
    );
    for (const k of PREFERENCE_KEYS) expect(validated.has(k)).toBe(true);
  });

  it.each(Object.entries(CLIENT_KEYS))("accepts client key %s=%s and stores it", async (k, v) => {
    const res = await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ [k]: v })
      .expect(200);
    expect(res.body[k]).toBe(v);
    expect(store.get(`caller-1|${k}`)).toBe(v);
  });

  it.each([
    ["staffBuyerChangeEmail", "yes"],
    ["staffBuyerChangeEmail", null],
    ["staffOrderEmail", "yes"],
    ["staffOrderEmail", null],
    ["pushEnabled", "yes"],
    ["pushEnabled", true],
    ["pushEnabled", null],
    ["locale", "fr"],
    ["locale", 5],
    ["bill.lastSupplierId", "x".repeat(65)],
    ["bill.lastSupplierId", 7],
    ["bill.lastSupplierId", null],
    ["payment.lastMethod", "BITCOIN"],
    ["payment.lastMethod", null],
    ["orders.posMode", "yes"],
    ["orders.posMode", true],
    ["orders.posMode", null],
    ["orders.posMode", "TRUE"],
  ])("rejects %s=%p with 400 and writes nothing", async (k, v) => {
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ [k]: v })
      .expect(400);
    expect(store.size).toBe(0);
  });

  it("rejects an unknown key with 400 and writes nothing (even beside valid keys)", async () => {
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ pushEnabled: "false", someFutureKey: "anything" })
      .expect(400);
    expect(store.size).toBe(0);
  });

  it("rejects a __proto__ key and array/non-object bodies", async () => {
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .set("Content-Type", "application/json")
      .send('{"__proto__":{"x":"y"}}')
      .expect(400);
    await request(app.getHttpServer()).patch("/users/me/preferences").send(["a"]).expect(400);
    expect(store.size).toBe(0);
  });

  it("empty body is a no-op 200", async () => {
    await request(app.getHttpServer()).patch("/users/me/preferences").send({}).expect(200);
    expect(store.size).toBe(0);
  });

  it("keys the write to the JWT user; a userId in the body is an unknown key (400, no write)", async () => {
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ [LOW_STOCK_DIGEST_PREF_KEY]: "false", userId: "victim-9" })
      .expect(400);
    expect(store.size).toBe(0);
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ [LOW_STOCK_DIGEST_PREF_KEY]: "false" })
      .expect(200);
    expect([...store.keys()].every((k) => k.startsWith("caller-1|"))).toBe(true);
  });

  // SA-763r P-1a red row (3): the POS mode preference is a sticky per-user switch.
  it("orders.posMode: PATCH true -> 200, GET reads it back; unset reads as absent (= off)", async () => {
    const before = await request(app.getHttpServer()).get("/users/me/preferences").expect(200);
    expect(before.body).not.toHaveProperty("orders.posMode");
    const res = await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ "orders.posMode": "true" })
      .expect(200);
    expect(res.body["orders.posMode"]).toBe("true");
    const got = await request(app.getHttpServer()).get("/users/me/preferences").expect(200);
    expect(got.body["orders.posMode"]).toBe("true");
    await request(app.getHttpServer())
      .patch("/users/me/preferences")
      .send({ "orders.posMode": "false" })
      .expect(200);
    const off = await request(app.getHttpServer()).get("/users/me/preferences").expect(200);
    expect(off.body["orders.posMode"]).toBe("false");
    expect([...store.keys()].every((k) => k.startsWith("caller-1|"))).toBe(true);
  });
});
