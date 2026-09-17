/**
 * Security regression tests — multer field-parser hardening.
 *
 * CVE-2026-82333 / GHSA-535w-7cp7-47q4: multer's field parser turns a bracket
 * group of digits into an array index, so ONE field named `a[999999999]`
 * materialises a sparse array of that length. Building it is cheap; the process
 * pays when it iterates or serialises `req.body`, blocking the event loop.
 *
 * Two things have to hold, and they fail independently — hence two suites:
 *
 *   1. The RESOLVED multer must be >= 2.3.0. @nestjs/platform-express pins multer
 *      at an EXACT 2.2.0, so without the root `overrides` entry the hoisted copy
 *      every FileInterceptor resolves stays vulnerable while the lockfile shows a
 *      2.3.0 nested somewhere nothing imports from. That is precisely how the
 *      original bump shipped green and fixed nothing.
 *   2. The guard is OPT-IN (`fieldArrayIndexLimit` defaults to Infinity), so every
 *      upload route must actually pass it — see common/upload-limits.ts.
 */

import { Controller, INestApplication, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Test, TestingModule } from "@nestjs/testing";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { MB, uploadLimits } from "../common/upload-limits";
import { MulterExceptionFilter } from "../common/multer-exception.filter";
import { SentryExceptionFilter } from "../common/sentry-exception.filter";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

// ─── 1. The override actually moved the copy that gets used ───────────────────

describe("multer override — the hoisted copy is the one that matters", () => {
  it("resolves multer >= 2.3.0 from @nestjs/platform-express, not just somewhere in the tree", () => {
    // Resolve exactly the way platform-express does at runtime: from ITS directory,
    // walking up. This is the check that a lockfile diff cannot fake — a nested
    // 2.3.0 under apps/api would not satisfy it.
    const req = createRequire(__filename);
    const platformExpressDir = dirname(req.resolve("@nestjs/platform-express/package.json"));
    const fromPlatformExpress = createRequire(`${platformExpressDir}/`);
    const resolved = fromPlatformExpress("multer/package.json") as { version: string };

    const [major, minor] = resolved.version.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(2);
    expect(major > 2 || minor >= 3).toBe(true);
  });

  it("exposes the LIMIT_FIELD_ARRAY_INDEX guard the mitigation depends on", () => {
    // 2.2.0 has no such code. If this is absent the limit below is inert, and a
    // green suite would be meaningless.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MulterError } = require("multer");
    const err = new MulterError("LIMIT_FIELD_ARRAY_INDEX", "a[1]");
    expect(err.message).toBe("Field name array index too large");
  });
});

// ─── 2. The limit is set, reaches multer, and answers 400 ─────────────────────

@Controller("probe")
class ProbeController {
  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { limits: uploadLimits(MB(1)) }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return { ok: true, filename: file?.originalname ?? null };
  }
}

/** Same interceptor with the guard removed — the mutation this suite must catch. */
@Controller("unguarded")
class UnguardedController {
  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MB(1) } }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return { ok: true, filename: file?.originalname ?? null };
  }
}

describe("multer field-parser limits (CVE-2026-82333)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProbeController, UnguardedController],
    }).compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts exactly, including order: the catch-all Sentry filter is
    // registered FIRST so the narrow MulterError filter (registered last) is the
    // one Nest reaches. Registering them the other way round is the regression
    // this ordering assertion exists to catch.
    app.useGlobalFilters(
      new SentryExceptionFilter(app.getHttpAdapter()),
      new MulterExceptionFilter(),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an absurd bracket array index with 400, not 500", async () => {
    const res = await request(app.getHttpServer())
      .post("/probe/upload")
      .field("a[999999999]", "x")
      .attach("file", Buffer.from("hello"), "note.txt");

    // 400 is the whole point. A 500 here means the limit fired but nothing mapped
    // the error — which would also mean one Sentry capture per attacker request.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("array index too large");
  });

  it("PROVES the limit is what rejects it — the same request without the guard is accepted", async () => {
    const res = await request(app.getHttpServer())
      .post("/unguarded/upload")
      .field("a[999999999]", "x")
      .attach("file", Buffer.from("hello"), "note.txt");

    // Without fieldArrayIndexLimit multer happily materialises the sparse array.
    // If this ever starts returning 400, the test above has stopped being evidence
    // (something else would be rejecting the request) and both need re-deriving.
    expect(res.status).toBe(201);
  });

  it("still accepts the repeated plain field names every RouteFlow client sends", async () => {
    // apps/web and apps/mobile send focalX/focalY as repeated plain names, never
    // bracket-indexed. The limit must not touch them.
    const res = await request(app.getHttpServer())
      .post("/probe/upload")
      .field("focalX", "50")
      .field("focalX", "25")
      .field("focalY", "50")
      .field("focalY", "75")
      .attach("file", Buffer.from("hello"), "photo.jpg");

    expect(res.status).toBe(201);
    expect(res.body.filename).toBe("photo.jpg");
  });

  it("accepts a small bracket index, so the ceiling bounds attackers not callers", async () => {
    const res = await request(app.getHttpServer())
      .post("/probe/upload")
      .field("items[3]", "ok")
      .attach("file", Buffer.from("hello"), "note.txt");

    expect(res.status).toBe(201);
  });

  it("bounds bracket nesting depth too", async () => {
    const res = await request(app.getHttpServer())
      .post("/probe/upload")
      .field("a[b][c][d][e][f][g]", "deep")
      .attach("file", Buffer.from("hello"), "note.txt");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("nesting too deep");
  });
});

// ─── 3. A REAL upload route actually receives its file ────────────────────────
//
// The suites above use a probe controller, which proves the multer/Nest wiring
// but not that a shipped route works. Until this spec, NOTHING in the repo posted
// multipart and asserted the file arrived — nine upload controllers with no
// behavioural oracle. That gap is why a dependency change was able to silently
// disable every upload (the nested media-typer orphan): multer stops recognising
// `multipart/form-data`, skips the request, and the route answers 200 with no
// file, no exception and no log. `validate-lock` was the only thing in the way.

import { TenantsController } from "../tenants/tenants.controller";
import { TenantsService } from "../tenants/tenants.service";
import { EmailService } from "../email/email.service";
import { AddonService } from "../billing/addon.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";

describe("a shipped upload route receives its file (silent-skip oracle)", () => {
  let app: INestApplication;
  const received: Array<{ originalname: string; size: number; mimetype: string }> = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TenantsController],
      providers: [
        {
          provide: TenantsService,
          useValue: {
            uploadLogo: (_tenantId: string, file: Express.Multer.File) => {
              received.push({
                originalname: file.originalname,
                size: file.buffer.length,
                mimetype: file.mimetype,
              });
              return Promise.resolve({ logoKey: "k", logoUrl: "u" });
            },
          },
        },
        { provide: EmailService, useValue: {} },
        { provide: AddonService, useValue: {} },
        { provide: FeatureOverrideService, useValue: {} },
      ],
    })
      // Auth is not what this proves; the multipart body is.
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: (ctx: never) => injectUser(ctx) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /tenants/me/config/branding/logo parses the multipart body and hands a real Buffer to the service", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const res = await request(app.getHttpServer())
      .post("/tenants/me/config/branding/logo")
      .attach("logo", png, { filename: "logo.png", contentType: "image/png" });

    // A 400 here means the MIME allowlist rejected it; a 200 with nothing in
    // `received` means multer silently skipped the request — the exact failure
    // this suite exists to make loud.
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].originalname).toBe("logo.png");
    expect(received[0].mimetype).toBe("image/png");
    expect(received[0].size).toBe(png.length);
  });
});

/** Minimal request-user injection so the controller's @CurrentUser() resolves. */
function injectUser(ctx: never): boolean {
  const http = (
    ctx as unknown as { switchToHttp: () => { getRequest: () => Record<string, unknown> } }
  ).switchToHttp();
  http.getRequest().user = { tenantId: "t1", tenantSlug: "acme", sub: "u1" };
  return true;
}

// ─── 4. The helper carries the guard at all ───────────────────────────────────

describe("uploadLimits", () => {
  it("carries both opt-in field guards alongside the per-route file size", () => {
    const limits = uploadLimits(MB(25)) as Record<string, number>;
    expect(limits.fileSize).toBe(25 * 1024 * 1024);
    // Both default to Infinity in multer; a missing key is a silently inert guard.
    expect(Number.isFinite(limits.fieldArrayIndexLimit)).toBe(true);
    expect(Number.isFinite(limits.fieldNestingDepth)).toBe(true);
  });
});
