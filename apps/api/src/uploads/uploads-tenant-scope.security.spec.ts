/**
 * JWT-path tenant scoping for the local uploads controller.
 *
 * When a caller authenticates with a JWT bearer token (not an HMAC-signed URL),
 * the controller enforces tenant ownership against the caller's own tenantId,
 * so a bearer token can't fetch another tenant's files by guessing a key.
 *
 * Two enforcement mechanisms:
 *  - `tenants/`, `regulated-filings/`, `tobacco-reports/` embed the tenantId
 *    directly in the key and are checked via regex.
 *  - `products/`, `customers/`, `payments/`, `expenses/`, `invoice-scans/`,
 *    `invoice-pdfs/`, `statement-pdfs/` (B12) embed only the OWNING ROW's id —
 *    the controller resolves that row's `tenantId` via a DB lookup instead.
 *
 * B12: previously only the three regex-matched prefixes above were checked;
 * the other eight (per `Owner lookup` below, collapsing to 7 distinct
 * prefixes since `customers/` covers both tax-documents/ and documents/)
 * streamed to ANY authenticated caller in ANY tenant who knew or guessed a
 * key. This file used to contain a passing test asserting that 200 leak for
 * `products/` — it is inverted below to assert 403.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Writable } from "stream";

import { INestApplication, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

import { UploadsController } from "./uploads.controller";
import { UploadsAccessGuard } from "./uploads-access.guard";
import { PrismaService } from "../prisma/prisma.service";

describe("UploadsController — JWT-path tenant scoping", () => {
  let app: INestApplication;
  let tmpDir: string;

  // Owner rows keyed by id, mirroring the real tables the B12 lookups hit.
  // Missing-id lookups (a bad/guessed id) resolve to `null`, exercising the
  // fail-closed branch.
  const owners: Record<string, { tenantId: string | null } | undefined> = {
    p1: { tenantId: "t1" },
    // Owned by the ATTACKER's tenant — used to prove the owner gate can't be
    // walked past with a `..` segment on a row the caller legitimately owns.
    p2: { tenantId: "t2" },
    c1: { tenantId: "t1" },
    scan1: { tenantId: "t1" },
    inv1: { tenantId: "t1" },
  };
  // Null-`tenantId` rows are real in prod (nested-create trap), so the
  // controller resolves those through the parent row. `eOrphan` has no parent
  // either and must still fail closed.
  const expenses: Record<string, { tenantId: string | null; vendorBillId: string | null }> = {
    e1: { tenantId: "t1", vendorBillId: null },
    eNull: { tenantId: null, vendorBillId: "vb1" },
    eOrphan: { tenantId: null, vendorBillId: null },
  };
  const vendorBills: Record<string, { tenantId: string | null } | undefined> = {
    vb1: { tenantId: "t1" },
  };
  const paymentOwners: Record<
    string,
    { tenantId: string | null; invoice: { tenantId: string | null } } | undefined
  > = {
    pay1: { tenantId: "t1", invoice: { tenantId: "t1" } },
    payNull: { tenantId: null, invoice: { tenantId: "t1" } },
  };

  const prismaMock = {
    product: { findUnique: jest.fn(({ where: { id } }) => Promise.resolve(owners[id] ?? null)) },
    customer: { findUnique: jest.fn(({ where: { id } }) => Promise.resolve(owners[id] ?? null)) },
    expense: { findUnique: jest.fn(({ where: { id } }) => Promise.resolve(expenses[id] ?? null)) },
    vendorBill: {
      findUnique: jest.fn(({ where: { id } }) => Promise.resolve(vendorBills[id] ?? null)),
    },
    invoiceScan: {
      findUnique: jest.fn(({ where: { id } }) => Promise.resolve(owners[id] ?? null)),
    },
    invoice: { findUnique: jest.fn(({ where: { id } }) => Promise.resolve(owners[id] ?? null)) },
    invoicePayment: {
      findFirst: jest.fn(({ where: { OR } }) => {
        const id = OR.find((clause: any) => "id" in clause)?.id;
        const paymentGroupId = OR.find((clause: any) => "paymentGroupId" in clause)?.paymentGroupId;
        return Promise.resolve(paymentOwners[id] ?? paymentOwners[paymentGroupId] ?? null);
      }),
    },
  };

  const write = (key: string) => {
    const dest = path.join(tmpDir, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from("net,sales\n1,2\n"));
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-uploads-scope-"));
    write("regulated-filings/t1/cat/2026-01.csv");
    write("tobacco-reports/t1/2026-01.csv");
    write("tenants/t1/doc.txt");
    write("products/p1/img.txt");
    write("customers/c1/documents/doc.txt");
    write("payments/pay1/receipt.txt");
    write("expenses/e1/receipt.txt");
    write("invoice-scans/scan1/scan.txt");
    write("invoice-pdfs/inv1.pdf");
    write("statement-pdfs/c1/2026-01.pdf");
    write("products/missing/img.txt");
    write("products/p2/img.txt");
    write("payments/payNull/receipt.txt");
    write("expenses/eNull/receipt.txt");
    write("expenses/eOrphan/receipt.txt");

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === "uploadDir" ? tmpDir : undefined) },
        },
        { provide: PrismaService, useValue: prismaMock },
      ],
    })
      // Simulate the JWT path: set req.user from test headers. Only marks the
      // request as signed-URL-authorized when the test explicitly opts in via
      // x-test-signed, so by default the controller's tenant check runs.
      .overrideGuard(UploadsAccessGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const tenantId = req.headers["x-test-tenant"] as string | undefined;
          const role = (req.headers["x-test-role"] as string) ?? "OPERATOR";
          req.user = { tenantId, role };
          // Simulate the signed-URL path (the real signature is verified by
          // UploadsAccessGuard itself, out of scope for this suite) so we can
          // prove it still exempts the new B12 owner-lookup check.
          if (req.headers["x-test-signed"]) {
            req.signedUrlAuthorized = true;
          }
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const get = (key: string, tenant?: string, role?: string, signed?: boolean) => {
    const r = request(app.getHttpServer()).get(`/uploads/${key}`);
    if (tenant) r.set("x-test-tenant", tenant);
    if (role) r.set("x-test-role", role);
    if (signed) r.set("x-test-signed", "1");
    return r;
  };

  it("serves a regulated filing to its OWN tenant", async () => {
    expect((await get("regulated-filings/t1/cat/2026-01.csv", "t1")).status).toBe(200);
  });

  it("blocks a regulated filing for a DIFFERENT tenant (403)", async () => {
    expect((await get("regulated-filings/t1/cat/2026-01.csv", "t2")).status).toBe(403);
  });

  it("blocks a tobacco report for a different tenant (403)", async () => {
    expect((await get("tobacco-reports/t1/2026-01.csv", "t2")).status).toBe(403);
  });

  it("still blocks the pre-existing tenants/ prefix cross-tenant (403)", async () => {
    expect((await get("tenants/t1/doc.txt", "t2")).status).toBe(403);
  });

  it("lets SUPER_ADMIN cross tenant boundaries", async () => {
    expect(
      (await get("regulated-filings/t1/cat/2026-01.csv", undefined, "SUPER_ADMIN")).status,
    ).toBe(200);
  });

  // B12: was "does not tenant-gate non-scoped prefixes (products/)" and
  // asserted 200 for a cross-tenant fetch — that was the leak. Inverted.
  it("B12: blocks a cross-tenant products/ fetch via owner-row lookup (403)", async () => {
    expect((await get("products/p1/img.txt", "t2")).status).toBe(403);
  });

  it("B12: serves products/ to its OWNING tenant", async () => {
    expect((await get("products/p1/img.txt", "t1")).status).toBe(200);
  });

  it("B12: blocks a cross-tenant customers/ fetch (403)", async () => {
    expect((await get("customers/c1/documents/doc.txt", "t2")).status).toBe(403);
  });

  it("B12: serves customers/ to its OWNING tenant", async () => {
    expect((await get("customers/c1/documents/doc.txt", "t1")).status).toBe(200);
  });

  it("B12: blocks a cross-tenant invoice-pdfs/ fetch (403)", async () => {
    expect((await get("invoice-pdfs/inv1.pdf", "t2")).status).toBe(403);
  });

  it("B12: serves invoice-pdfs/ to its OWNING tenant", async () => {
    expect((await get("invoice-pdfs/inv1.pdf", "t1")).status).toBe(200);
  });

  it("B12: blocks a cross-tenant payments/ fetch (403)", async () => {
    expect((await get("payments/pay1/receipt.txt", "t2")).status).toBe(403);
  });

  it("B12: serves payments/ to its OWNING tenant", async () => {
    expect((await get("payments/pay1/receipt.txt", "t1")).status).toBe(200);
  });

  it("B12: blocks a cross-tenant expenses/ fetch (403)", async () => {
    expect((await get("expenses/e1/receipt.txt", "t2")).status).toBe(403);
  });

  it("B12: serves expenses/ to its OWNING tenant", async () => {
    expect((await get("expenses/e1/receipt.txt", "t1")).status).toBe(200);
  });

  it("B12: blocks a cross-tenant invoice-scans/ fetch (403)", async () => {
    expect((await get("invoice-scans/scan1/scan.txt", "t2")).status).toBe(403);
  });

  it("B12: serves invoice-scans/ to its OWNING tenant", async () => {
    expect((await get("invoice-scans/scan1/scan.txt", "t1")).status).toBe(200);
  });

  it("B12: blocks a cross-tenant statement-pdfs/ fetch (403)", async () => {
    expect((await get("statement-pdfs/c1/2026-01.pdf", "t2")).status).toBe(403);
  });

  it("B12: serves statement-pdfs/ to its OWNING tenant", async () => {
    expect((await get("statement-pdfs/c1/2026-01.pdf", "t1")).status).toBe(200);
  });

  it("B12: SUPER_ADMIN still crosses tenant boundaries for an id-based prefix", async () => {
    expect((await get("products/p1/img.txt", undefined, "SUPER_ADMIN")).status).toBe(200);
  });

  it("B12: a missing owner row denies (fail closed), even for the requester's own tenant", async () => {
    expect((await get("products/missing/img.txt", "t1")).status).toBe(403);
  });

  it("B12: a signed URL still serves an id-based prefix cross-tenant (signature is a per-key capability)", async () => {
    expect((await get("products/p1/img.txt", "t2", undefined, true)).status).toBe(200);
  });

  // ─── Dot-segment traversal must not walk past either tenant gate ───────────
  // Both gates read the RAW key, but the file is read from `path.join(dir,key)`
  // which normalizes `..` — so a `..` segment lands on a DIFFERENT file than
  // the one that was authorized, while still resolving inside the upload root
  // (so the traversal check passes too).
  //
  // These go through the controller directly rather than supertest: the WHATWG
  // URL parser in the HTTP client collapses `..` (and `%2e%2e`) client-side, so
  // supertest physically cannot send one. A raw client (`curl --path-as-is`)
  // can, and Express then hands the wildcard param straight through as a
  // decoded array without normalizing it — which is exactly the shape below.
  const callDirect = async (segments: string[], tenantId?: string, role = "OPERATOR") => {
    const controller = new UploadsController(
      { get: (k: string) => (k === "uploadDir" ? tmpDir : undefined) } as any,
      prismaMock as any,
    );
    const req = {
      path: `/api/v1/uploads/${segments.join("/")}`,
      user: { tenantId, role },
    } as any;
    // A real Writable, so that WITHOUT the guard the file actually streams and
    // the call resolves — the assertions below would then fail honestly rather
    // than passing on an incidental TypeError.
    const res = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), {
      setHeader: jest.fn(),
    }) as any;
    return controller.serveFile({ path: segments }, req, res);
  };

  it("B12: `..` cannot walk from an OWNED product key into another tenant's file", async () => {
    // p2 belongs to the caller's OWN tenant, so the owner lookup passes — then
    // the `..` segments resolve onto t1's file inside the same root.
    await expect(
      callDirect(["products", "p2", "..", "..", "tenants", "t1", "doc.txt"], "t2"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("B12: `..` under an unknown prefix cannot reach a gated key (no gate matches `x/`)", async () => {
    await expect(callDirect(["x", "..", "products", "p1", "img.txt"], "t2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("B12: `..` cannot defeat the pre-existing tenants/ regex either", async () => {
    await expect(callDirect(["tenants", "t2", "..", "t1", "doc.txt"], "t2")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ─── Null-tenantId owner rows resolve through their parent ─────────────────

  it("B12: a payment whose own tenantId is null resolves through its invoice and serves", async () => {
    expect((await get("payments/payNull/receipt.txt", "t1")).status).toBe(200);
  });

  it("B12: a null-tenantId payment is still blocked cross-tenant (403)", async () => {
    expect((await get("payments/payNull/receipt.txt", "t2")).status).toBe(403);
  });

  it("B12: an expense whose own tenantId is null resolves through its vendor bill and serves", async () => {
    expect((await get("expenses/eNull/receipt.txt", "t1")).status).toBe(200);
  });

  it("B12: a null-tenantId expense is still blocked cross-tenant (403)", async () => {
    expect((await get("expenses/eNull/receipt.txt", "t2")).status).toBe(403);
  });

  it("B12: a null-tenantId expense with no parent bill still fails closed (403)", async () => {
    expect((await get("expenses/eOrphan/receipt.txt", "t1")).status).toBe(403);
  });
});
