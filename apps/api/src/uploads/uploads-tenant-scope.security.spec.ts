/**
 * JWT-path tenant scoping for the local uploads controller.
 *
 * When a caller authenticates with a JWT bearer token (not an HMAC-signed URL),
 * the controller enforces the tenantId embedded in tenant-scoped storage prefixes
 * against the caller's own tenantId, so a bearer token can't fetch another
 * tenant's files by guessing a key. Covers `tenants/`, `regulated-filings/`, and
 * `tobacco-reports/` (the last two are the W5b/W1 regulatory artifacts).
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

import { UploadsController } from "./uploads.controller";
import { UploadsAccessGuard } from "./uploads-access.guard";

describe("UploadsController — JWT-path tenant scoping", () => {
  let app: INestApplication;
  let tmpDir: string;

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        {
          provide: ConfigService,
          useValue: { get: (k: string) => (k === "uploadDir" ? tmpDir : undefined) },
        },
      ],
    })
      // Simulate the JWT path: set req.user from test headers, never mark the
      // request as signed-URL-authorized (so the controller's tenant check runs).
      .overrideGuard(UploadsAccessGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const tenantId = req.headers["x-test-tenant"] as string | undefined;
          const role = (req.headers["x-test-role"] as string) ?? "OPERATOR";
          req.user = { tenantId, role };
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

  const get = (key: string, tenant?: string, role?: string) => {
    const r = request(app.getHttpServer()).get(`/uploads/${key}`);
    if (tenant) r.set("x-test-tenant", tenant);
    if (role) r.set("x-test-role", role);
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

  it("does not tenant-gate non-scoped prefixes (products/)", async () => {
    // No `<prefix>/<tenantId>/` match → no cross-tenant check; file serves.
    expect((await get("products/p1/img.txt", "t2")).status).toBe(200);
  });
});
