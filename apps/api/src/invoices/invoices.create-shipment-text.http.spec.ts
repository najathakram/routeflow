import "reflect-metadata";
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { CreateInvoiceDto } from "./dto/create-invoice.dto";
import { UpdateInvoiceDto } from "./dto/update-invoice.dto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/**
 * Row 507 (fold): `POST /invoices` carries the same carrier / tracking text rules as the shipment PATCH, at
 * the DTO layer (invoices.service.ts is at its size cap): trimmed, capped 64 / 128, and a formula-led value
 * is the coded 400 TEXT_CELL_FORMULA_LEAD (same body as `assertSafeTextCell`). PATCH /invoices/:id
 * accepts and ignores these two fields, so it must not be blocked by an echoed legacy value.
 */
const BASE = {
  customerId: "11111111-1111-4111-8111-111111111111",
  items: [{ description: "Tomatoes", qty: 1, unitPrice: 4.5 }],
};
const pipe = () =>
  new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });

describe("POST /invoices: carrier / tracking text (controller level)", () => {
  let app: INestApplication;
  const invoices = { create: jest.fn(), update: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        { provide: InvoicesService, useValue: invoices },
        { provide: InvoicePdfService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      // H3b (#3435): the controller passes the caller's id as the override actor, so the stub signs a user in
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = { sub: "u-test", role: "TENANT_ADMIN" };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(pipe());
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    invoices.create.mockResolvedValue({ id: "inv-1" });
    invoices.update.mockResolvedValue({ id: "inv-1" });
  });

  it.each([
    ["shippingTrackingNumber", "=HYPERLINK(1)"],
    ["shippingTrackingNumber", "  +cmd"],
    ["shippingCarrier", "@SUM(1)"],
    ["shippingCarrier", "-x"],
  ])(
    "a formula-led %s %j is a 400 TEXT_CELL_FORMULA_LEAD naming the field; nothing is created",
    async (field, value) => {
      const res = await request(app.getHttpServer())
        .post("/invoices")
        .send({ ...BASE, [field]: value });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
      expect(typeof res.body.message).toBe("string");
      expect(invoices.create).not.toHaveBeenCalled();
    },
  );

  it("over-long values are 400 (carrier 65, tracking 129), also when only padding fits the cap", async () => {
    for (const body of [
      { shippingCarrier: "C".repeat(65) },
      { shippingTrackingNumber: "9".repeat(129) },
    ]) {
      const res = await request(app.getHttpServer())
        .post("/invoices")
        .send({ ...BASE, ...body });
      expect(res.status).toBe(400);
    }
    const ok = await request(app.getHttpServer())
      .post("/invoices")
      .send({
        ...BASE,
        shippingCarrier: `${"C".repeat(64)}   `,
        shippingTrackingNumber: ` ${"9".repeat(128)}`,
      });
    expect(ok.status).toBe(201);
  });

  it("the service receives the TRIMMED values; a numeric-only tracking number is accepted", async () => {
    const res = await request(app.getHttpServer())
      .post("/invoices")
      .send({ ...BASE, shippingCarrier: "  UPS ", shippingTrackingNumber: " -12345678 " });
    expect(res.status).toBe(201);
    expect(invoices.create.mock.calls[0][0]).toMatchObject({
      shippingCarrier: "UPS",
      shippingTrackingNumber: "-12345678",
    });
  });

  it("PATCH /invoices/:id still accepts an echoed formula-led pair (the fields are ignored there)", async () => {
    const res = await request(app.getHttpServer())
      .patch("/invoices/inv-1")
      .send({ shippingCarrier: "=Legacy", shippingTrackingNumber: "=LEGACY1", notes: "x" });
    expect(res.status).toBe(200);
  });
});

describe("DTO layer: CreateInvoiceDto / UpdateInvoiceDto through the real pipe", () => {
  const run = (metatype: new () => object, value: object) =>
    pipe().transform(value, { type: "body", metatype });

  it("CreateInvoiceDto refuses a formula-led carrier with the assertSafeTextCell body shape", async () => {
    await expect(run(CreateInvoiceDto, { ...BASE, shippingCarrier: "=1+1" })).rejects.toMatchObject(
      {
        status: 400,
        response: {
          statusCode: 400,
          code: "TEXT_CELL_FORMULA_LEAD",
          field: "shippingCarrier",
          message: "Carrier can't start with =, +, -, @ or a tab/line break",
          error: "Bad Request",
        },
      },
    );
  });

  it("UpdateInvoiceDto does not formula-check (not written there) but still trims", async () => {
    const out: any = await run(UpdateInvoiceDto, { shippingCarrier: " =Legacy " });
    expect(out.shippingCarrier).toBe("=Legacy");
  });
});
