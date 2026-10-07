// PR2 SEC-1 (guard metadata) and SEC-2 (tenant + impersonation tokens are refused on every route),
// driven through the real JwtStrategy / JwtAuthGuard / SuperAdminGuard over HTTP, plus the DTO
// bounds. The service is a stub: a refused request must leave it untouched.
import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import request from "supertest";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { JwtStrategy } from "../auth/strategies/jwt.strategy";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { RfInvoicesController } from "./rf-invoices.controller";
import { RfInvoicesAdminService } from "./rf-invoices.service";
import { RfInvoiceMailerService } from "../billing/rf-invoice/rf-invoice-mailer.service";
import { PlatformAdminController } from "./platform-admin.controller";
import {
  MarkRfInvoicePaidDto,
  RfInvoiceListQueryDto,
  RfInvoiceReasonDto,
  SendRfInvoicesDto,
} from "./dto/rf-invoice.dto";

const SECRET = "rf-invoices-controller-test-secret";
const ID = "0b1f6c1e-6a39-4b8e-9d0e-3f5f4d1c2a77";

const ROUTES: Array<[string, string, string]> = [
  ["GET", "rf-invoices", "list"],
  ["GET", "rf-invoices/summary", "summary"],
  ["POST", "rf-invoices/:id/mark-paid", "markPaid"],
  ["POST", "rf-invoices/:id/reopen", "reopen"],
  ["POST", "rf-invoices/:id/void", "voidInvoice"],
  ["POST", "tenants/:id/rf-invoices/issue", "issueForTenant"],
  // PR3: the email routes (service: RfInvoiceMailerService)
  ["POST", "rf-invoices/:id/send", "sendOne"],
  ["POST", "rf-invoices/send", "sendMany"],
];

describe("SEC-1 guard metadata", () => {
  it("class-level JwtAuthGuard then SuperAdminGuard, under /platform-admin", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RfInvoicesController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, RfInvoicesController)).toBe("platform-admin");
  });

  it("exposes exactly the eight routes, none with a method-level guard override", () => {
    const proto = RfInvoicesController.prototype as any;
    const found = Object.getOwnPropertyNames(proto)
      .filter((n) => n !== "constructor" && typeof proto[n] === "function")
      .filter((n) => Reflect.getMetadata(PATH_METADATA, proto[n]) !== undefined)
      .map((n) => {
        const verb = Reflect.getMetadata(METHOD_METADATA, proto[n]);
        return { n, verb, path: Reflect.getMetadata(PATH_METADATA, proto[n]) };
      });
    const methodName = ["GET", "POST"];
    expect(
      found
        .map((f) => [methodName[f.verb] ?? f.verb, f.path, f.n])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([...ROUTES].sort((a, b) => a[1].localeCompare(b[1])));
    for (const f of found) {
      expect(Reflect.getMetadata(GUARDS_METADATA, proto[f.n])).toBeUndefined();
    }
  });

  it("PR3: both send routes are @Throttle({ default: { limit: 20, ttl: 60_000 } })", () => {
    const proto = RfInvoicesController.prototype as any;
    for (const fn of ["sendOne", "sendMany"]) {
      expect(Reflect.getMetadata("THROTTLER:LIMITdefault", proto[fn])).toBe(20);
      expect(Reflect.getMetadata("THROTTLER:TTLdefault", proto[fn])).toBe(60_000);
    }
  });

  it("platform-admin.controller.ts is untouched by this feature (no rf-invoice route there)", () => {
    const proto = PlatformAdminController.prototype as any;
    const paths = Object.getOwnPropertyNames(proto)
      .filter((n) => typeof proto[n] === "function")
      .map((n) => Reflect.getMetadata(PATH_METADATA, proto[n]))
      .filter((p) => typeof p === "string");
    expect(paths.filter((p) => p.includes("rf-invoice"))).toEqual([]);
  });
});

describe("SEC-2 only a platform super-admin reaches any route", () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: SECRET });
  const svc = {
    list: jest.fn().mockResolvedValue({ rows: [], meta: { total: 0, page: 1, limit: 50 } }),
    summary: jest.fn().mockResolvedValue({}),
    markPaid: jest.fn().mockResolvedValue({}),
    reopen: jest.fn().mockResolvedValue({}),
    voidInvoice: jest.fn().mockResolvedValue({}),
    issueForTenant: jest.fn().mockResolvedValue({}),
  };
  const mailer = {
    sendManual: jest.fn().mockResolvedValue({ id: "x", outcome: "sent" }),
    sendMany: jest.fn().mockResolvedValue({ results: [] }),
  };

  const claims = (over: Record<string, unknown>) => ({
    sub: "u1",
    username: "someone",
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: "tenant-acme",
    tenantSlug: "acme",
    ...over,
  });
  const token = (over: Record<string, unknown>) => jwt.sign(claims(over), { expiresIn: "15m" });

  const tokens: Array<[string, string | null]> = [
    ["tenant admin", token({ role: "TENANT_ADMIN" })],
    ["operator", token({ role: "OPERATOR" })],
    ["driver", token({ role: "DRIVER" })],
    ["customer", token({ role: "CUSTOMER" })],
    [
      "impersonation (a super-admin acting as a tenant admin)",
      token({ role: "TENANT_ADMIN", impersonatedBy: "sa-1" }),
    ],
    ["no token", null],
  ];

  const call = (verb: string, path: string, t: string | null) => {
    const url = `/platform-admin/${path.replace(":id", ID)}`;
    const r =
      verb === "GET"
        ? request(app.getHttpServer()).get(url)
        : request(app.getHttpServer()).post(url);
    if (t) r.set("Authorization", `Bearer ${t}`);
    if (verb !== "POST") return r;
    if (path === "rf-invoices/send") return r.send({ ids: [ID] });
    if (path.endsWith("/send")) return r.send({});
    if (path.endsWith("mark-paid")) return r.send({ method: "CASH" });
    return path.endsWith("issue") ? r.send({}) : r.send({ reason: "a reason" });
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [RfInvoicesController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === "jwt" ? { secret: SECRET } : undefined) },
        },
        { provide: RfInvoicesAdminService, useValue: svc },
        { provide: RfInvoiceMailerService, useValue: mailer },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  for (const [verb, path] of ROUTES) {
    it.each(tokens)(`${verb} /${path}: %s is refused`, async (name, t) => {
      const res = await call(verb, path, t);
      expect(res.status).toBe(name === "no token" ? 401 : 403);
      for (const fn of [...Object.values(svc), ...Object.values(mailer)]) {
        expect(fn).not.toHaveBeenCalled();
      }
    });

    it(`${verb} /${path}: a SUPER_ADMIN gets through`, async () => {
      const res = await call(
        verb,
        path,
        token({ role: "SUPER_ADMIN", tenantId: null, tenantSlug: null }),
      );
      expect(res.status).toBeLessThan(300);
    });
  }

  const sa = () => token({ role: "SUPER_ADMIN", tenantId: null, tenantSlug: null });
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `0b1f6c1e-6a39-4b8e-9d0e-3f5f4d1c2${String(i).padStart(3, "0")}`,
    );

  it("API-7: bulk send takes 1..50 uuids; 51, 0, a non-uuid and a stray field are 400 with nothing sent", async () => {
    const post = (body: object) =>
      request(app.getHttpServer())
        .post("/platform-admin/rf-invoices/send")
        .set("Authorization", `Bearer ${sa()}`)
        .send(body);
    expect((await post({ ids: ids(50) })).status).toBe(200);
    mailer.sendMany.mockClear();
    expect((await post({ ids: ids(51) })).status).toBe(400);
    expect((await post({ ids: [] })).status).toBe(400);
    expect((await post({ ids: ["not-a-uuid"] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ ids: ids(1), extra: 1 })).status).toBe(400);
    expect(mailer.sendMany).not.toHaveBeenCalled();
  });

  it("the acting admin's id reaches the mailer on both send routes", async () => {
    await call("POST", "rf-invoices/:id/send", sa());
    expect(mailer.sendManual).toHaveBeenCalledWith(ID, "u1");
    await call("POST", "rf-invoices/send", sa());
    expect(mailer.sendMany).toHaveBeenCalledWith([ID], "u1");
  });

  it("the acting admin's id reaches the service", async () => {
    await call("POST", "rf-invoices/:id/mark-paid", token({ role: "SUPER_ADMIN", tenantId: null }));
    expect(svc.markPaid).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ method: "CASH" }),
      "u1",
    );
  });
});

describe("request DTOs", () => {
  const errors = async (cls: any, plain: object) =>
    (await validate(plainToInstance(cls, plain))).map((e) => e.property);

  it("list query: bounds on q, limit, view, sort and dir", async () => {
    expect(await errors(RfInvoiceListQueryDto, {})).toEqual([]);
    expect(
      await errors(RfInvoiceListQueryDto, {
        limit: "100",
        page: "2",
        view: "overdue",
        sort: "amount",
        dir: "desc",
      }),
    ).toEqual([]);
    expect(await errors(RfInvoiceListQueryDto, { limit: "0" })).toContain("limit");
    expect(await errors(RfInvoiceListQueryDto, { limit: "101" })).toContain("limit");
    expect(await errors(RfInvoiceListQueryDto, { page: "0" })).toContain("page");
    expect(await errors(RfInvoiceListQueryDto, { q: "x".repeat(101) })).toContain("q");
    expect(await errors(RfInvoiceListQueryDto, { view: "everything" })).toContain("view");
    expect(await errors(RfInvoiceListQueryDto, { sort: "colour" })).toContain("sort");
    expect(await errors(RfInvoiceListQueryDto, { dir: "sideways" })).toContain("dir");
  });

  it("mark-paid: method from the external-payment list, reference <= 100, note <= 500, ISO paidAt", async () => {
    expect(
      await errors(MarkRfInvoicePaidDto, {
        method: "ZELLE",
        reference: "r",
        note: "n",
        paidAt: "2026-10-01",
      }),
    ).toEqual([]);
    expect(await errors(MarkRfInvoicePaidDto, {})).toContain("method");
    expect(await errors(MarkRfInvoicePaidDto, { method: "BITCOIN" })).toContain("method");
    expect(
      await errors(MarkRfInvoicePaidDto, { method: "CASH", reference: "x".repeat(101) }),
    ).toContain("reference");
    expect(await errors(MarkRfInvoicePaidDto, { method: "CASH", note: "x".repeat(501) })).toContain(
      "note",
    );
    expect(await errors(MarkRfInvoicePaidDto, { method: "CASH", paidAt: "yesterday" })).toContain(
      "paidAt",
    );
  });

  it("reason: 3 to 500 characters", async () => {
    expect(await errors(RfInvoiceReasonDto, { reason: "abc" })).toEqual([]);
    expect(await errors(RfInvoiceReasonDto, { reason: "ab" })).toContain("reason");
    expect(await errors(RfInvoiceReasonDto, { reason: "x".repeat(501) })).toContain("reason");
    expect(await errors(RfInvoiceReasonDto, {})).toContain("reason");
  });

  it("bulk send ids: an array of 1 to 50 uuids", async () => {
    const u = "0b1f6c1e-6a39-4b8e-9d0e-3f5f4d1c2a77";
    expect(await errors(SendRfInvoicesDto, { ids: [u] })).toEqual([]);
    expect(await errors(SendRfInvoicesDto, { ids: Array(50).fill(u) })).toEqual([]);
    expect(await errors(SendRfInvoicesDto, { ids: Array(51).fill(u) })).toContain("ids");
    expect(await errors(SendRfInvoicesDto, { ids: [] })).toContain("ids");
    expect(await errors(SendRfInvoicesDto, { ids: ["x"] })).toContain("ids");
    expect(await errors(SendRfInvoicesDto, {})).toContain("ids");
  });
});
