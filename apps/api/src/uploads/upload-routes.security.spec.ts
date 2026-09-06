/**
 * Upload-route integration coverage — every shipped multipart endpoint.
 *
 * WHY THESE EXIST, AND WHY THEY ASSERT WHAT THEY DO
 * If multer stops recognising `multipart/form-data`, it does not throw. It
 * SKIPS the request: the route runs, `@UploadedFile()` is `undefined`, the
 * handler's own "no file" guard returns a 400 — or worse, a handler that maps
 * over `files` returns 200 with an empty result — and there is no exception,
 * no log and no red test. The caller sees success while the file vanishes.
 *
 * That is not hypothetical. During the multer 2.3.0 override (#590) a lockfile
 * edit orphaned `node_modules/multer/node_modules/media-typer@0.3.0`, so
 * `type-is@1.6.18` fell through to an incompatible root `media-typer@1.1.0` and
 * every upload in the product silently stopped parsing. Nothing in the repo
 * caught it except `scripts/validate-lock-edges.mjs`, because until #590 there
 * was no test anywhere that posted multipart and asserted the file ARRIVED.
 *
 * So the load-bearing assertion in every case below is not the status code —
 * it is that the service layer received a real Buffer with the expected
 * originalname, mimetype and byte length. A 200/201 proves nothing here.
 *
 * Where a route carries a `fileFilter`, the rejection path is asserted too: a
 * disallowed MIME must 400 rather than silently upload. Those filters are the
 * RF-076/RF-157 stored-XSS guards, so a filter that stops running is a security
 * regression that this suite would otherwise miss.
 */

// `invoice-template.tsx` is JSX, and the api Jest project's moduleFileExtensions
// are js/json/ts only — so any spec whose import graph reaches
// `bookkeeping/invoice.service` must stub it. Same virtual mock the existing
// bookkeeping specs use; the PDF templates that DO have moduleNameMapper entries
// (invoice-pdf-template, statement-pdf-template, tobacco-report-pdf) need nothing.
jest.mock("../bookkeeping/invoice-template", () => ({ InvoiceTemplate: () => null }), {
  virtual: true,
});

import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Request } from "express";

import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { AddonGuard } from "../billing/addon.guard";
import { PlanFlagGuard } from "../billing/plan-flag.guard";

import { ProductsController } from "../products/products.controller";
import { ProductsService } from "../products/products.service";
import { CustomersController } from "../customers/customers.controller";
import { CustomersService } from "../customers/customers.service";
import { StatementService } from "../buyer/statement.service";
import { StatementPdfService } from "../buyer/statement-pdf.service";
import { VendorBillsController } from "../vendor-bills/vendor-bills.controller";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { SupplierStatementsController } from "../supplier-statements/supplier-statements.controller";
import { SupplierStatementsService } from "../supplier-statements/supplier-statements.service";
import { StatementApplyService } from "../supplier-statements/statement-apply.service";
import { BatchController } from "../import/batch.controller";
import { BatchImportService } from "../import/batch-import.service";
import { InvoicesController } from "../invoices/invoices.controller";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { BookkeepingController } from "../bookkeeping/bookkeeping.controller";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";
import { ImportController } from "../import/import.controller";
import { ImportService } from "../import/import.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

// 60 s budget for these multipart tests: real Buffers over real HTTP through the full
// multipart parser refused pushes twice on host load (2026-09-05/06) under Jest's 5 s default.
jest.setTimeout(60_000);

/** What a handler handed to its service — the thing these tests actually check. */
type Received = { originalname: string; mimetype: string; size: number; isBuffer: boolean };

/** 8-byte PNG magic; content is irrelevant, byte-count is not. */
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const PDF = Buffer.from("%PDF-1.4\n%tiny\n");

/**
 * Boots a real Nest app around ONE real controller with its service mocked.
 *
 * Auth is not what these prove, so all four guards are stubbed open — including
 * ones a given controller does not use, which Nest tolerates and which keeps
 * the helper uniform. `req.user` is injected because several handlers take
 * `@CurrentUser()` and would otherwise receive undefined.
 */
async function bootstrap(
  controller: unknown,
  providers: Array<{ provide: unknown; useValue: unknown }>,
) {
  const moduleRef = await Test.createTestingModule({
    controllers: [controller as never],
    providers: providers as never,
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: { switchToHttp: () => { getRequest: () => Request } }) => {
        (ctx.switchToHttp().getRequest() as unknown as Record<string, unknown>).user = {
          id: "u1",
          sub: "u1",
          tenantId: "t1",
          tenantSlug: "acme",
        };
        return true;
      },
    })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(AddonGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(PlanFlagGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

/** Records what a service method was handed, in the shape the assertions want. */
function recorder(received: Received[]) {
  return (buffer: Buffer, originalname: string, mimetype: string) => {
    received.push({
      originalname,
      mimetype,
      size: buffer?.length ?? -1,
      isBuffer: Buffer.isBuffer(buffer),
    });
    return Promise.resolve({ key: "k", url: "u" });
  };
}

// ─── products: POST /products/:id/images ─────────────────────────────────────
// The highest-value route in the set: the only upload that also consumes
// multipart TEXT fields, so it exercises the field parser as well as the file
// parser — the two halves that fail independently.

describe("POST /products/:id/images", () => {
  let app: INestApplication;
  const received: Received[] = [];
  const focals: Array<{ x: number; y: number } | undefined> = [];

  beforeAll(async () => {
    app = await bootstrap(ProductsController, [
      {
        provide: ProductsService,
        useValue: {
          uploadImage: (
            _id: string,
            buffer: Buffer,
            originalname: string,
            mimetype: string,
            focal?: { x: number; y: number },
          ) => {
            focals.push(focal);
            return recorder(received)(buffer, originalname, mimetype);
          },
        },
      },
    ]);
  });

  afterAll(async () => await app.close());
  beforeEach(() => {
    received.length = 0;
    focals.length = 0;
  });

  it("receives every file as a real Buffer with its name, type and byte length", async () => {
    const res = await request(app.getHttpServer())
      .post("/products/p1/images")
      .attach("files", PNG, { filename: "a.png", contentType: "image/png" })
      .attach("files", PNG, { filename: "b.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(received).toHaveLength(2);
    expect(received.map((r) => r.originalname)).toEqual(["a.png", "b.png"]);
    expect(received.every((r) => r.isBuffer && r.size === PNG.length)).toBe(true);
    expect(received.every((r) => r.mimetype === "image/png")).toBe(true);
  });

  it("pairs repeated focalX/focalY TEXT fields with their file by index", async () => {
    // The clients send these as repeated plain names, never bracket-indexed —
    // so this is also the regression test for the field parser still running.
    const res = await request(app.getHttpServer())
      .post("/products/p1/images")
      .field("focalX", "10")
      .field("focalY", "20")
      .field("focalX", "30")
      .field("focalY", "40")
      .attach("files", PNG, { filename: "a.png", contentType: "image/png" })
      .attach("files", PNG, { filename: "b.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(focals).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it("rejects a disallowed MIME with 400 and uploads nothing (RF-076 stored-XSS guard)", async () => {
    const res = await request(app.getHttpServer())
      .post("/products/p1/images")
      .attach("files", Buffer.from("<svg onload=alert(1)>"), {
        filename: "evil.svg",
        contentType: "image/svg+xml",
      });

    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

// ─── customers: tax-documents and documents ──────────────────────────────────

describe("POST /customers/:id/tax-documents and /documents", () => {
  let app: INestApplication;
  const tax: Received[] = [];
  const docs: Received[] = [];

  beforeAll(async () => {
    app = await bootstrap(CustomersController, [
      {
        provide: CustomersService,
        useValue: {
          uploadTaxDocument: (_id: string, b: Buffer, n: string, m: string) =>
            recorder(tax)(b, n, m),
          uploadCustomerDocument: (_id: string, b: Buffer, n: string, m: string) =>
            recorder(docs)(b, n, m),
        },
      },
      { provide: StatementService, useValue: {} },
      { provide: StatementPdfService, useValue: {} },
    ]);
  });

  afterAll(async () => await app.close());
  beforeEach(() => {
    tax.length = 0;
    docs.length = 0;
  });

  it("tax-documents receives a real PDF Buffer", async () => {
    const res = await request(app.getHttpServer())
      .post("/customers/c1/tax-documents")
      .attach("files", PDF, { filename: "w9.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(tax).toEqual([
      { originalname: "w9.pdf", mimetype: "application/pdf", size: PDF.length, isBuffer: true },
    ]);
  });

  it("tax-documents rejects a disallowed MIME with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/customers/c1/tax-documents")
      .attach("files", Buffer.from("x"), { filename: "e.svg", contentType: "image/svg+xml" });

    expect(res.status).toBe(400);
    expect(tax).toHaveLength(0);
  });

  it("documents receives a real Buffer", async () => {
    const res = await request(app.getHttpServer())
      .post("/customers/c1/documents")
      .attach("files", PNG, { filename: "scan.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(docs).toEqual([
      { originalname: "scan.png", mimetype: "image/png", size: PNG.length, isBuffer: true },
    ]);
  });

  it("documents rejects a disallowed MIME with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/customers/c1/documents")
      .attach("files", Buffer.from("x"), { filename: "e.svg", contentType: "image/svg+xml" });

    expect(res.status).toBe(400);
    expect(docs).toHaveLength(0);
  });
});

// ─── vendor-bills: POST /vendor-bills/scan-invoice ───────────────────────────
// Field name is `images`, not `files` — multer matches exactly, so a client
// using the wrong name gets a silent no-file. Asserted explicitly below.

describe("POST /vendor-bills/scan-invoice", () => {
  let app: INestApplication;
  let seen: Array<{ name: string; type: string; size: number; isBuffer: boolean }> = [];

  beforeAll(async () => {
    app = await bootstrap(VendorBillsController, [
      {
        provide: VendorBillsService,
        useValue: {
          // The controller re-shapes multer's file into {buffer, mimeType,
          // fileName, size} before the service sees it — assert THAT contract,
          // not multer's, or the test passes on a shape nothing sends.
          scanInvoice: (
            files: Array<{ buffer: Buffer; mimeType: string; fileName: string; size: number }>,
          ) => {
            seen = files.map((f) => ({
              name: f.fileName,
              type: f.mimeType,
              size: f.size,
              isBuffer: Buffer.isBuffer(f.buffer),
            }));
            return Promise.resolve({ ok: true });
          },
        },
      },
    ]);
  });

  afterAll(async () => await app.close());
  beforeEach(() => (seen = []));

  it("receives files posted under the `images` field name", async () => {
    const res = await request(app.getHttpServer())
      .post("/vendor-bills/scan-invoice")
      .attach("images", PDF, { filename: "bill.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(seen).toEqual([
      { name: "bill.pdf", type: "application/pdf", size: PDF.length, isBuffer: true },
    ]);
  });

  it("rejects the wrong field name rather than silently accepting no file", async () => {
    // multer matches the field name exactly; `files` here is NOT `images`.
    const res = await request(app.getHttpServer())
      .post("/vendor-bills/scan-invoice")
      .attach("files", PDF, { filename: "bill.pdf", contentType: "application/pdf" });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(0);
  });
});

// ─── supplier-statements: POST /supplier-statements/scan ─────────────────────

describe("POST /supplier-statements/scan", () => {
  let app: INestApplication;
  let seen: Array<{ name: string; size: number; isBuffer: boolean }> = [];

  beforeAll(async () => {
    app = await bootstrap(SupplierStatementsController, [
      {
        provide: SupplierStatementsService,
        useValue: {
          // Same re-shape as vendor-bills: {buffer, mimeType, fileName, size}.
          scanStatement: (files: Array<{ buffer: Buffer; fileName: string; size: number }>) => {
            seen = files.map((f) => ({
              name: f.fileName,
              size: f.size,
              isBuffer: Buffer.isBuffer(f.buffer),
            }));
            return Promise.resolve({ ok: true });
          },
        },
      },
      { provide: StatementApplyService, useValue: {} },
    ]);
  });

  afterAll(async () => await app.close());

  it("receives a real Buffer for each scanned page", async () => {
    const res = await request(app.getHttpServer())
      .post("/supplier-statements/scan")
      .attach("files", PDF, { filename: "stmt.pdf", contentType: "application/pdf" })
      .attach("files", PNG, { filename: "p2.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(seen).toEqual([
      { name: "stmt.pdf", size: PDF.length, isBuffer: true },
      { name: "p2.png", size: PNG.length, isBuffer: true },
    ]);
  });
});

// ─── import/batch: POST /import/batch/:id/scan ───────────────────────────────

describe("POST /import/batch/:id/scan", () => {
  let app: INestApplication;
  let seen: Array<{ mimeType: string; size: number; isBuffer: boolean }> = [];
  let firstName: string | undefined;

  beforeAll(async () => {
    app = await bootstrap(BatchController, [
      {
        provide: BatchImportService,
        useValue: {
          scanAndRecord: (
            _id: string,
            files: Array<{ buffer: Buffer; mimeType: string }>,
            name?: string,
          ) => {
            seen = files.map((f) => ({
              mimeType: f.mimeType,
              size: f.buffer.length,
              isBuffer: Buffer.isBuffer(f.buffer),
            }));
            firstName = name;
            return Promise.resolve({ ok: true });
          },
        },
      },
    ]);
  });

  afterAll(async () => await app.close());

  it("maps each file to {buffer, mimeType} and forwards the first originalname", async () => {
    const res = await request(app.getHttpServer())
      .post("/import/batch/b1/scan")
      .attach("files", PDF, { filename: "page1.pdf", contentType: "application/pdf" })
      .attach("files", PNG, { filename: "page2.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(seen).toEqual([
      { mimeType: "application/pdf", size: PDF.length, isBuffer: true },
      { mimeType: "image/png", size: PNG.length, isBuffer: true },
    ]);
    expect(firstName).toBe("page1.pdf");
  });
});

// ─── invoices: POST /invoices/payments/:paymentId/image ──────────────────────

describe("POST /invoices/payments/:paymentId/image", () => {
  let app: INestApplication;
  const received: Received[] = [];

  beforeAll(async () => {
    app = await bootstrap(InvoicesController, [
      {
        provide: InvoicesService,
        useValue: {
          uploadPaymentImage: (_id: string, b: Buffer, n: string, m: string) =>
            recorder(received)(b, n, m),
        },
      },
      { provide: InvoicePdfService, useValue: {} },
    ]);
  });

  afterAll(async () => await app.close());
  beforeEach(() => (received.length = 0));

  it("hands the service a real Buffer with name and mimetype", async () => {
    const res = await request(app.getHttpServer())
      .post("/invoices/payments/pay1/image")
      .attach("file", PNG, { filename: "receipt.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(received).toEqual([
      { originalname: "receipt.png", mimetype: "image/png", size: PNG.length, isBuffer: true },
    ]);
  });

  it("400s when no file is attached, rather than uploading an empty record", async () => {
    const res = await request(app.getHttpServer()).post("/invoices/payments/pay1/image");
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

// ─── bookkeeping: POST /bookkeeping/expenses/:id/receipt ─────────────────────

describe("POST /bookkeeping/expenses/:id/receipt", () => {
  let app: INestApplication;
  const received: Received[] = [];

  beforeAll(async () => {
    app = await bootstrap(BookkeepingController, [
      {
        provide: BookkeepingService,
        useValue: {
          uploadExpenseReceipt: (_id: string, b: Buffer, n: string, m: string) =>
            recorder(received)(b, n, m),
        },
      },
    ]);
  });

  afterAll(async () => await app.close());
  beforeEach(() => (received.length = 0));

  it("hands the service a real Buffer with name and mimetype", async () => {
    const res = await request(app.getHttpServer())
      .post("/bookkeeping/expenses/e1/receipt")
      .attach("file", PDF, { filename: "receipt.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(received).toEqual([
      {
        originalname: "receipt.pdf",
        mimetype: "application/pdf",
        size: PDF.length,
        isBuffer: true,
      },
    ]);
  });

  it("400s when no file is attached", async () => {
    const res = await request(app.getHttpServer()).post("/bookkeeping/expenses/e1/receipt");
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});

// ─── import: the seven CSV/spreadsheet routes ────────────────────────────────
// All seven share one shape — FileInterceptor("file") then `file.buffer` into a
// service — so they are covered as a table rather than seven near-identical
// blocks. Each still posts a real multipart body and asserts the bytes landed.

describe("POST /import/* (7 spreadsheet routes)", () => {
  let app: INestApplication;
  const calls: Record<string, Received[]> = {};

  const ROUTES: Array<[path: string, method: string]> = [
    ["contacts", "importContacts"],
    ["invoices", "importInvoices"],
    ["payments", "importPayments"],
    ["expenses", "importExpenses"],
    ["products", "importProducts"],
    ["inventory", "importInventory"],
    ["expense-suppliers", "importExpenseSuppliers"],
  ];

  beforeAll(async () => {
    const useValue: Record<string, unknown> = {};
    for (const [, method] of ROUTES) {
      calls[method] = [];
      useValue[method] = (buffer: Buffer) => {
        calls[method].push({
          originalname: "(not passed)",
          mimetype: "(not passed)",
          size: buffer?.length ?? -1,
          isBuffer: Buffer.isBuffer(buffer),
        });
        return Promise.resolve({ ok: true });
      };
    }
    app = await bootstrap(ImportController, [{ provide: ImportService, useValue }]);
  });

  afterAll(async () => await app.close());

  it.each(ROUTES)(
    "POST /import/%s hands %s a real Buffer of the posted bytes",
    async (p, method) => {
      const csv = Buffer.from(`name,qty\nacme,${p}\n`);
      const res = await request(app.getHttpServer())
        .post(`/import/${p}`)
        .attach("file", csv, { filename: `${p}.csv`, contentType: "text/csv" });

      expect(res.status).toBe(200);
      expect(calls[method]).toHaveLength(1);
      expect(calls[method][0].isBuffer).toBe(true);
      expect(calls[method][0].size).toBe(csv.length);
    },
  );
});
