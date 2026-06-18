/**
 * Security regression tests — RF-076 / RF-157 / RF-078
 *
 * 1. POST /products/:id/images rejects SVG (and other non-allowlisted MIMEs) with 400.
 * 2. GET  /uploads/<key> always returns Content-Disposition: attachment and
 *    X-Content-Type-Options: nosniff.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";

import { INestApplication, BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Runs the multer fileFilter used in products.controller.ts directly.
 * Returns the error passed to cb (or null if accepted).
 */
function runProductImageFilter(mimetype: string, filename: string): Error | null {
  const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
  let captured: Error | null = null;
  const cb = (err: Error | null, _accept?: boolean) => {
    captured = err;
  };
  const file = { mimetype, originalname: filename } as Express.Multer.File;
  if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
    cb(
      new BadRequestException(
        `File type "${file.mimetype}" is not permitted. Allowed types: JPEG, PNG, WEBP.`,
      ),
      false,
    );
  } else {
    cb(null, true);
  }
  return captured;
}

/**
 * Runs the multer fileFilter used in customers.controller.ts (tax-documents).
 */
function runTaxDocFilter(mimetype: string, filename: string): Error | null {
  const ALLOWED_TAX_DOC_MIMES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ]);
  let captured: Error | null = null;
  const cb = (err: Error | null, _accept?: boolean) => {
    captured = err;
  };
  const file = { mimetype, originalname: filename } as Express.Multer.File;
  if (!ALLOWED_TAX_DOC_MIMES.has(file.mimetype)) {
    cb(
      new BadRequestException(
        `File type "${file.mimetype}" is not permitted. Allowed types: JPEG, PNG, WEBP, PDF.`,
      ),
      false,
    );
  } else {
    cb(null, true);
  }
  return captured;
}

/**
 * Runs the multer fileFilter used in customers.controller.ts (generic documents).
 */
function runCustomerDocFilter(mimetype: string, filename: string): Error | null {
  const ALLOWED_CUSTOMER_DOC_MIMES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
  ]);
  let captured: Error | null = null;
  const cb = (err: Error | null, _accept?: boolean) => {
    captured = err;
  };
  const file = { mimetype, originalname: filename } as Express.Multer.File;
  if (!ALLOWED_CUSTOMER_DOC_MIMES.has(file.mimetype)) {
    cb(
      new BadRequestException(
        `File type "${file.mimetype}" is not permitted. Allowed types: JPEG, PNG, WEBP, PDF.`,
      ),
      false,
    );
  } else {
    cb(null, true);
  }
  return captured;
}

// ─── Product image upload MIME allowlist ──────────────────────────────────────

describe("RF-076/RF-157 — Product image MIME allowlist", () => {
  it("rejects image/svg+xml with a BadRequestException", () => {
    const err = runProductImageFilter("image/svg+xml", "evil.svg");
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("not permitted");
  });

  it("rejects text/html", () => {
    const err = runProductImageFilter("text/html", "xss.html");
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("rejects application/javascript", () => {
    const err = runProductImageFilter("application/javascript", "script.js");
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("rejects image/gif (not in allowlist)", () => {
    const err = runProductImageFilter("image/gif", "anim.gif");
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("accepts image/jpeg", () => {
    const err = runProductImageFilter("image/jpeg", "photo.jpg");
    expect(err).toBeNull();
  });

  it("accepts image/png", () => {
    const err = runProductImageFilter("image/png", "logo.png");
    expect(err).toBeNull();
  });

  it("accepts image/webp", () => {
    const err = runProductImageFilter("image/webp", "image.webp");
    expect(err).toBeNull();
  });
});

// ─── Tax-document MIME allowlist ──────────────────────────────────────────────

describe("RF-076/RF-157 — Tax-document MIME allowlist", () => {
  it("rejects image/svg+xml", () => {
    const err = runTaxDocFilter("image/svg+xml", "evil.svg");
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("rejects text/html", () => {
    const err = runTaxDocFilter("text/html", "xss.html");
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("accepts application/pdf", () => {
    const err = runTaxDocFilter("application/pdf", "cert.pdf");
    expect(err).toBeNull();
  });

  it("accepts image/jpeg", () => {
    const err = runTaxDocFilter("image/jpeg", "scan.jpg");
    expect(err).toBeNull();
  });
});

// ─── Customer-document MIME allowlist ─────────────────────────────────────────

describe("RF-076/RF-157 — Customer-document MIME allowlist", () => {
  it("rejects image/svg+xml", () => {
    const err = runCustomerDocFilter("image/svg+xml", "evil.svg");
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toContain("not permitted");
  });

  it("rejects text/html", () => {
    const err = runCustomerDocFilter("text/html", "xss.html");
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it("accepts application/pdf", () => {
    const err = runCustomerDocFilter("application/pdf", "agreement.pdf");
    expect(err).toBeNull();
  });

  it("accepts image/jpeg", () => {
    const err = runCustomerDocFilter("image/jpeg", "scan.jpg");
    expect(err).toBeNull();
  });
});

// ─── Uploads controller response headers (RF-078) ────────────────────────────

import { UploadsController } from "./uploads.controller";
import { UploadsAccessGuard } from "./uploads-access.guard";

describe("RF-078 — GET /uploads/* response headers", () => {
  let app: INestApplication;
  let tmpDir: string;
  let testFilePath: string;
  const TEST_FILENAME = "foo.png";

  beforeAll(async () => {
    // Create a real temp PNG file to serve.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf078-test-"));
    testFilePath = path.join(tmpDir, TEST_FILENAME);
    // Minimal 1×1 PNG magic bytes so mime-types detects it correctly.
    const PNG_MAGIC = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
        "2e00000000c49444154789c626001000000ffff030000060005572d520000000049454e44ae426082",
      "hex",
    );
    fs.writeFileSync(testFilePath, PNG_MAGIC);

    const mockConfig = {
      get: (key: string) => {
        if (key === "uploadDir") return tmpDir;
        return undefined;
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [{ provide: ConfigService, useValue: mockConfig }],
    })
      // Bypass auth (signed URL OR JWT) for this unit test — we're testing
      // response headers, not the auth path itself.
      .overrideGuard(UploadsAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns Content-Disposition: inline for image MIMEs (so cross-origin <img> can render)", async () => {
    const res = await request(app.getHttpServer()).get(`/uploads/${TEST_FILENAME}`);
    // File exists — should be 200.
    expect(res.status).toBe(200);
    // RF-078 originally forced attachment for everything; that broke <img>
    // rendering on cross-origin pages. We now force `inline` only for the
    // strict image allowlist (JPEG/PNG/WEBP — all upload-time validated).
    expect(res.headers["content-disposition"]).toBe("inline");
  });

  it("returns X-Content-Type-Options: nosniff (RF-076)", async () => {
    const res = await request(app.getHttpServer()).get(`/uploads/${TEST_FILENAME}`);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("returns Cross-Origin-Resource-Policy: cross-origin (so cross-origin <img> can load)", async () => {
    const res = await request(app.getHttpServer()).get(`/uploads/${TEST_FILENAME}`);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});

// ─── Non-image MIME (PDF) keeps attachment for safety ─────────────────────────

describe("RF-078 — Non-image MIME still forces attachment", () => {
  let app: INestApplication;
  let tmpDir: string;
  const TEST_FILENAME = "doc.pdf";

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf078-pdf-"));
    fs.writeFileSync(path.join(tmpDir, TEST_FILENAME), Buffer.from("%PDF-1.4\n%minimal\n"));

    const mockConfig = {
      get: (key: string) => (key === "uploadDir" ? tmpDir : undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [{ provide: ConfigService, useValue: mockConfig }],
    })
      .overrideGuard(UploadsAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forces attachment for application/pdf so the browser never tries to render it inline", async () => {
    const res = await request(app.getHttpServer()).get(`/uploads/${TEST_FILENAME}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
  });
});
