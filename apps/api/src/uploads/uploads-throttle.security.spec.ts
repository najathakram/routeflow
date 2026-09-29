/**
 * #2091 — signed product-image GETs must not be rate-limited by the global API throttle.
 *
 * The global ThrottlerGuard (app.module.ts APP_GUARD) allowed 100 requests / 60 s per IP on
 * every handler, GET /uploads/* included. One catalog page (or several staff behind one shop
 * IP) loads far more images than that, so images past the 100th got a 429 and rendered broken
 * until the window reset — "a reload sometimes fixes it".
 *
 * This drives a real Nest app with the PRODUCTION throttler set (`buildThrottlers`, the same
 * function app.module.ts registers), the real global ThrottlerGuard, the real
 * UploadsAccessGuard and a real JwtStrategy — so the exemption is proven against the actual
 * guard chain, and the signature check is proven untouched by it. Only the throttler STORAGE
 * differs (in-memory instead of Redis; both are fixed-window counters keyed the same way).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { Controller, Get, INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

import { JwtStrategy } from "../auth/strategies/jwt.strategy";
import { buildThrottlers } from "../common/throttlers";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { PrismaService } from "../prisma/prisma.service";
import { signLocalUrl } from "../storage/storage.service";
import { UploadsController } from "./uploads.controller";

const SIGNING_SECRET = "throttle-spec-signing-secret";
const JWT_SECRET = "throttle-spec-jwt-secret";
const KEY = "products/prod-1/0b7c9d1e-img.png";

// 1x1 PNG
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
    "2e00000000c49444154789c626001000000ffff030000060005572d520000000049454e44ae426082",
  "hex",
);

/** An ordinary API route: the global 100 / 60 s throttle must still apply to it. */
@Controller("probe")
class ProbeController {
  @Get()
  ping() {
    return { ok: true };
  }
}

function signedPath(key: string, expiresAt = Date.now() + 3_600_000, sig?: string): string {
  const signature = sig ?? signLocalUrl(SIGNING_SECRET, key, expiresAt);
  return `/uploads/${key}?expires=${expiresAt}&sig=${encodeURIComponent(signature)}`;
}

/** The throttle window the scenarios must fit inside (the guard's fixed window is 60 s). */
const THROTTLE_WINDOW_MS = 60_000;

/**
 * Fire `count` GETs in parallel batches (a browser loads a catalog's images concurrently too)
 * and return every status in send order. Throws if the run did not fit inside ONE throttle
 * window: a slow host whose window reset mid-run would otherwise let the throttled build pass.
 */
async function fire(server: unknown, count: number, pathFor: () => string): Promise<number[]> {
  const started = Date.now();
  const statuses: number[] = [];
  const BATCH = 10;
  for (let sent = 0; sent < count; sent += BATCH) {
    const n = Math.min(BATCH, count - sent);
    const results = await Promise.all(
      Array.from({ length: n }, () => request(server).get(pathFor())),
    );
    statuses.push(...results.map((r: { status: number }) => r.status));
  }
  const elapsed = Date.now() - started;
  if (elapsed >= THROTTLE_WINDOW_MS) {
    throw new Error(
      `${count} requests took ${elapsed} ms — longer than one ${THROTTLE_WINDOW_MS} ms throttle ` +
        "window, so this run cannot say anything about per-window limits",
    );
  }
  return statuses;
}

/** Non-200 responses as `{ request: n (1-based), status }`, for a readable failure diff. */
function notOk(statuses: number[]): { request: number; status: number }[] {
  return statuses.map((status, i) => ({ request: i + 1, status })).filter((r) => r.status !== 200);
}

describe("#2091 — GET /uploads/* throttling (real guard chain, production throttler set)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rf-uploads-throttle-"));
    fs.mkdirSync(path.join(tmpDir, path.dirname(KEY)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, KEY), PNG);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
    const values: Record<string, unknown> = {
      uploadDir: tmpDir,
      "storage.urlSigningSecret": SIGNING_SECRET,
      jwt: { secret: JWT_SECRET },
      ...overrides,
    };
    return { get: (key: string) => values[key] } as unknown as ConfigService;
  }

  async function buildApp(config: ConfigService): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({ secret: JWT_SECRET }),
        ThrottlerModule.forRoot({ throttlers: buildThrottlers(config) }),
      ],
      controllers: [UploadsController, ProbeController],
      providers: [
        { provide: ConfigService, useValue: config },
        // Owner lookups never run on the signed-URL path; the dependency must still resolve.
        { provide: PrismaService, useValue: {} },
        JwtStrategy,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    // Constructing JwtStrategy registers the real passport "jwt" strategy that
    // UploadsAccessGuard falls back to when a request carries no valid signature.
    moduleRef.get(JwtStrategy);
    const app = moduleRef.createNestApplication();
    // #2267: bound to 127.0.0.1 once, so supertest never re-listens on [::] per request.
    await listenOnLoopback(app);
    return app;
  }

  describe("with the default limits", () => {
    let app: INestApplication;

    beforeEach(async () => {
      app = await buildApp(makeConfig());
    });

    afterEach(async () => {
      await app.close();
    });

    it("serves 150 signed image GETs from one IP inside one minute — every one a 200", async () => {
      const statuses = await fire(app.getHttpServer(), 150, () => signedPath(KEY));
      expect(statuses).toHaveLength(150);
      expect(notOk(statuses)).toEqual([]);
    }, 120_000);

    it("still throttles an ordinary API route at 100 / 60 s per IP", async () => {
      const statuses = await fire(app.getHttpServer(), 100, () => "/probe");
      expect(notOk(statuses)).toEqual([]);
      const res = await request(app.getHttpServer()).get("/probe");
      expect(res.status).toBe(429);
    }, 120_000);

    it("keeps the signature check: a tampered signature is refused 401 and the file is not served", async () => {
      const expiresAt = Date.now() + 3_600_000;
      const good = signLocalUrl(SIGNING_SECRET, KEY, expiresAt);
      const tampered = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
      const res = await request(app.getHttpServer()).get(signedPath(KEY, expiresAt, tampered));
      expect(res.status).toBe(401);
      expect(res.headers["content-type"] ?? "").not.toMatch(/^image\//);
    });

    it("keeps the signature check: an expired signature is refused 401", async () => {
      const expiresAt = Date.now() - 1_000;
      const res = await request(app.getHttpServer()).get(signedPath(KEY, expiresAt));
      expect(res.status).toBe(401);
    });

    it("keeps the signature check: a signature minted for a different key is refused 401", async () => {
      const expiresAt = Date.now() + 3_600_000;
      const otherSig = signLocalUrl(SIGNING_SECRET, "products/prod-1/other.png", expiresAt);
      const res = await request(app.getHttpServer()).get(signedPath(KEY, expiresAt, otherSig));
      expect(res.status).toBe(401);
    });

    it("keeps the signature check: no signature and no JWT is refused 401", async () => {
      const res = await request(app.getHttpServer()).get(`/uploads/${KEY}`);
      expect(res.status).toBe(401);
    });
  });

  describe("with a small image ceiling (the per-IP bound still exists)", () => {
    let app: INestApplication;

    beforeEach(async () => {
      app = await buildApp(makeConfig({ "throttle.uploadsLimit": 5 }));
    });

    afterEach(async () => {
      await app.close();
    });

    it("refuses the request past the image ceiling with a 429", async () => {
      const statuses = await fire(app.getHttpServer(), 5, () => signedPath(KEY));
      expect(notOk(statuses)).toEqual([]);
      const res = await request(app.getHttpServer()).get(signedPath(KEY));
      expect(res.status).toBe(429);
    }, 120_000);

    it("never applies the image ceiling to other routes", async () => {
      const statuses = await fire(app.getHttpServer(), 20, () => "/probe");
      expect(notOk(statuses)).toEqual([]);
    }, 120_000);
  });
});
