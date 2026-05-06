/**
 * Tests for HMAC-signed local upload URLs.
 *
 * StorageService.presignedUrl emits `?expires=&sig=` when running on
 * local-disk storage so cross-origin browser <img> tags can load images
 * without sending an Authorization header. UploadsAccessGuard accepts the
 * signature as auth.
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
import {
  signLocalUrl,
  verifyLocalUrlSignature,
  StorageService,
} from "../storage/storage.service";

describe("Local URL signing primitives", () => {
  const SECRET = "test-secret-deadbeef";

  it("signs and verifies a valid token", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signLocalUrl(SECRET, "products/abc/img.jpg", expiresAt);
    expect(verifyLocalUrlSignature(SECRET, "products/abc/img.jpg", expiresAt, sig)).toBe(true);
  });

  it("rejects an expired token", () => {
    const expiresAt = Date.now() - 1; // already expired
    const sig = signLocalUrl(SECRET, "x.jpg", expiresAt);
    expect(verifyLocalUrlSignature(SECRET, "x.jpg", expiresAt, sig)).toBe(false);
  });

  it("rejects a tampered key", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signLocalUrl(SECRET, "x.jpg", expiresAt);
    expect(verifyLocalUrlSignature(SECRET, "y.jpg", expiresAt, sig)).toBe(false);
  });

  it("rejects a tampered expiry", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signLocalUrl(SECRET, "x.jpg", expiresAt);
    expect(verifyLocalUrlSignature(SECRET, "x.jpg", expiresAt + 1000, sig)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signLocalUrl(SECRET, "x.jpg", expiresAt);
    expect(verifyLocalUrlSignature("other-secret", "x.jpg", expiresAt, sig)).toBe(false);
  });

  it("rejects empty inputs", () => {
    expect(verifyLocalUrlSignature(SECRET, "x.jpg", Date.now() + 60_000, "")).toBe(false);
    expect(verifyLocalUrlSignature("", "x.jpg", Date.now() + 60_000, "abc")).toBe(false);
    expect(verifyLocalUrlSignature(SECRET, "x.jpg", NaN, "abc")).toBe(false);
  });
});

describe("StorageService.presignedUrl — local-disk URL signing", () => {
  it("appends ?expires=&sig= when a signing secret is configured", async () => {
    const mockConfig = {
      get: (key: string) => {
        if (key === "r2.accountId") return "";
        if (key === "r2.accessKeyId") return "";
        if (key === "r2.secretAccessKey") return "";
        if (key === "r2.bucketName") return "routeflow-assets";
        if (key === "uploadDir") return "/tmp/test";
        if (key === "storage.urlSigningSecret") return "test-secret";
        if (key === "storage.urlExpirySeconds") return 3600;
        if (key === "port") return 3000;
        return undefined;
      },
    };
    const svc = new StorageService(mockConfig as unknown as ConfigService);
    const url = await svc.presignedUrl("products/abc/img.jpg");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/uploads/products/abc/img.jpg");
    expect(parsed.searchParams.has("expires")).toBe(true);
    expect(parsed.searchParams.has("sig")).toBe(true);
  });

  it("emits a bare URL when no signing secret is configured (safer than an unverifiable signature)", async () => {
    const mockConfig = {
      get: (key: string) => {
        if (key === "uploadDir") return "/tmp/test";
        if (key === "port") return 3000;
        if (key === "storage.urlSigningSecret") return "";
        return undefined;
      },
    };
    const svc = new StorageService(mockConfig as unknown as ConfigService);
    const url = await svc.presignedUrl("products/abc/img.jpg");
    expect(url).toBe("http://localhost:3000/api/v1/uploads/products/abc/img.jpg");
  });
});

describe("UploadsAccessGuard — end-to-end via supertest", () => {
  let app: INestApplication;
  let tmpDir: string;
  const TEST_FILENAME = "foo.png";
  const SECRET = "guard-test-secret";

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-signed-url-test-"));
    const PNG_MAGIC = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
        "2e00000000c49444154789c626001000000ffff030000060005572d520000000049454e44ae426082",
      "hex",
    );
    fs.writeFileSync(path.join(tmpDir, TEST_FILENAME), PNG_MAGIC);

    const mockConfig = {
      get: (key: string) => {
        if (key === "uploadDir") return tmpDir;
        if (key === "storage.urlSigningSecret") return SECRET;
        return undefined;
      },
    };

    // Build an app with the guard wired up but the JWT path stubbed to deny
    // (canActivate=false) so we can prove the SIGNED path is what's allowing
    // access without ever touching JWT.
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [{ provide: ConfigService, useValue: mockConfig }],
    })
      // The real guard tries to fall back to passport JWT when the signed
      // path fails, but passport isn't wired up in this isolated unit test.
      // Replace with an inline impl that exercises the signed-URL logic
      // and rejects everything else.
      .overrideGuard(UploadsAccessGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const urlMatch = req.path.match(/\/uploads\/(.+)$/);
          const key = urlMatch ? decodeURIComponent(urlMatch[1]) : "";
          const expires = parseInt((req.query.expires as string) ?? "", 10);
          const sig = (req.query.sig as string) ?? "";
          if (verifyLocalUrlSignature(SECRET, key, expires, sig)) {
            req.signedUrlAuthorized = true;
            return true;
          }
          return false;
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

  it("serves the file when the signed query string is valid", async () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signLocalUrl(SECRET, TEST_FILENAME, expiresAt);
    const res = await request(app.getHttpServer()).get(
      `/uploads/${TEST_FILENAME}?expires=${expiresAt}&sig=${encodeURIComponent(sig)}`,
    );
    expect(res.status).toBe(200);
    // PNG → inline so cross-origin <img> can render it.
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("rejects an expired signature", async () => {
    const expiresAt = Date.now() - 1000;
    const sig = signLocalUrl(SECRET, TEST_FILENAME, expiresAt);
    const res = await request(app.getHttpServer()).get(
      `/uploads/${TEST_FILENAME}?expires=${expiresAt}&sig=${encodeURIComponent(sig)}`,
    );
    // Guard returned false; Nest emits a 4xx (4xx semantics — exact code is
    // an internal detail). What matters is that the file is NOT served.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a tampered key (signature was for a different key)", async () => {
    const expiresAt = Date.now() + 60_000;
    const sig = signLocalUrl(SECRET, "different.png", expiresAt);
    const res = await request(app.getHttpServer()).get(
      `/uploads/${TEST_FILENAME}?expires=${expiresAt}&sig=${encodeURIComponent(sig)}`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects a missing signature", async () => {
    const res = await request(app.getHttpServer()).get(`/uploads/${TEST_FILENAME}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
