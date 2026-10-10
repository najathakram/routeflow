/**
 * #2091 — product image URLs must be STABLE for a period so the browser cache can hit.
 *
 * Every API response used to re-sign each image with a fresh `expires` (local disk) or a fresh
 * `X-Amz-Date` (R2), so the same image got a new URL on every page view and the uploads route's
 * `Cache-Control: private, max-age=31536000, immutable` never produced a single cache hit. Now a
 * product image's expiry is BUCKETED: every mint inside one window yields the identical URL, and
 * a mint near the end of a window rolls to the next one so a URL always has at least the
 * configured minimum lifetime (STORAGE_URL_EXPIRY_SECONDS, default 1 h) left.
 *
 * Only immutable, write-once keys get a stable URL (see STABLE_URL_KEY_PREFIXES). A key that is
 * rewritten in place (tenant logo, payment image, statement / invoice PDFs) keeps a per-mint URL,
 * because a stable URL plus the `immutable` header would pin a stale copy of it in the browser.
 */

import { ConfigService } from "@nestjs/config";

import { StorageService, verifyLocalUrlSignature } from "./storage.service";

const SECRET = "stability-spec-secret";
const PRODUCT_KEY = "products/prod-1/1f9e2c4a-0d6b-4a7e-9b1f-3c2d5e6f7a8b-fp50x40.jpg";
const HOUR = 3_600_000;
const MIN = 60_000;

/** 02:00 UTC — inside the 00:00–12:00 UTC window (12 h windows are epoch-aligned). */
const T0 = Date.parse("2026-09-24T02:00:00.000Z");
const NOON = Date.parse("2026-09-24T12:00:00.000Z");
const MIDNIGHT = Date.parse("2026-09-25T00:00:00.000Z");

function localConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    uploadDir: "/tmp/rf-stability",
    port: 3000,
    "storage.urlSigningSecret": SECRET,
    "storage.urlExpirySeconds": 3600,
    "storage.stableUrlWindowSeconds": 43_200,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function r2Config(): ConfigService {
  return localConfig({
    "r2.accountId": "0123456789abcdef0123456789abcdef",
    "r2.accessKeyId": "AKIDEXAMPLEEXAMPLE00",
    "r2.secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "r2.bucketName": "routeflow-assets",
  });
}

/** `expires` (ms epoch) of a local-disk signed URL. */
function localExpiry(url: string): number {
  return Number(new URL(url).searchParams.get("expires"));
}

/** The instant an R2 (SigV4) presigned URL stops working: X-Amz-Date + X-Amz-Expires. */
function r2Validity(url: string): { signedAt: number; expiresAt: number; expiresIn: number } {
  const params = new URL(url).searchParams;
  const amzDate = params.get("X-Amz-Date") ?? "";
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!m) throw new Error(`not a SigV4 presigned URL: ${url}`);
  const signedAt = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const expiresIn = Number(params.get("X-Amz-Expires"));
  return { signedAt, expiresAt: signedAt + expiresIn * 1000, expiresIn };
}

describe("#2091 — stable signed URLs for product images", () => {
  beforeEach(() => {
    // Fake ONLY the clock (Date.now and `new Date()`); real timers keep the SDK's internals intact.
    jest.useFakeTimers({
      now: T0,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("local-disk mode", () => {
    it("two presigns of the same product key in the same window are IDENTICAL", async () => {
      const svc = new StorageService(localConfig());
      const first = await svc.presignedUrl(PRODUCT_KEY);
      jest.setSystemTime(T0 + 7 * MIN + 13_000);
      const second = await svc.presignedUrl(PRODUCT_KEY);
      jest.setSystemTime(T0 + 8 * HOUR);
      const third = await svc.presignedUrl(PRODUCT_KEY);

      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it("signs the window's end as the expiry, verifiable by the UNCHANGED signature check", async () => {
      const svc = new StorageService(localConfig());
      const url = await svc.presignedUrl(PRODUCT_KEY);
      const parsed = new URL(url);

      expect(parsed.pathname).toBe(`/api/v1/uploads/${PRODUCT_KEY}`);
      expect(localExpiry(url)).toBe(NOON);
      expect(
        verifyLocalUrlSignature(SECRET, PRODUCT_KEY, NOON, parsed.searchParams.get("sig") ?? ""),
      ).toBe(true);
    });

    it("a presign near the end of a window rolls to the next window and keeps ≥ 1 h of validity", async () => {
      const svc = new StorageService(localConfig());

      const nearBoundary = NOON - 30 * MIN; // 11:30 — only 30 min left in this window
      jest.setSystemTime(nearBoundary);
      const late = await svc.presignedUrl(PRODUCT_KEY);
      expect(localExpiry(late) - nearBoundary).toBeGreaterThanOrEqual(HOUR);
      expect(localExpiry(late)).toBe(MIDNIGHT);

      // …and that rolled URL is the very one the next window hands out, so it stays cacheable.
      jest.setSystemTime(NOON + 5 * HOUR);
      expect(await svc.presignedUrl(PRODUCT_KEY)).toBe(late);
    });

    it("never mints a product URL with less than the minimum lifetime or more than window + minimum", async () => {
      const svc = new StorageService(localConfig());
      // Sweep a full day in 7-minute-and-a-bit steps (hits every phase of both windows).
      for (let t = T0; t < T0 + 24 * HOUR; t += 7 * MIN + 1_337) {
        jest.setSystemTime(t);
        const remaining = localExpiry(await svc.presignedUrl(PRODUCT_KEY)) - t;
        expect(remaining).toBeGreaterThanOrEqual(HOUR);
        expect(remaining).toBeLessThan(12 * HOUR + HOUR);
      }
    });

    it("honours a configured window and minimum lifetime", async () => {
      const svc = new StorageService(
        localConfig({
          "storage.urlExpirySeconds": 1800,
          "storage.stableUrlWindowSeconds": 4 * 3600,
        }),
      );
      jest.setSystemTime(Date.parse("2026-09-24T03:40:00.000Z")); // 4 h window ends 04:00
      const url = await svc.presignedUrl(PRODUCT_KEY);
      // 20 min left < 30 min minimum → rolls to the 08:00 window end.
      expect(localExpiry(url)).toBe(Date.parse("2026-09-24T08:00:00.000Z"));
    });

    it.each([
      ["statement PDF (re-rendered in place)", "statement-pdfs/cust-1/2026-09.pdf"],
      ["tenant logo (overwritten on re-upload)", "tenants/tenant-1/logo.png"],
      ["payment image (overwritten on re-upload)", "payments/pay-1/image.jpg"],
      ["invoice PDF (regenerated in place)", "invoice-pdfs/inv-1.pdf"],
      ["customer tax document", "customers/cust-1/tax-documents/doc-1.pdf"],
    ])("keeps a per-mint URL for a %s — exactly the minimum lifetime", async (_label, key) => {
      const svc = new StorageService(localConfig());
      const first = await svc.presignedUrl(key);
      expect(localExpiry(first)).toBe(T0 + HOUR);

      jest.setSystemTime(T0 + 7 * MIN);
      const second = await svc.presignedUrl(key);
      expect(localExpiry(second)).toBe(T0 + 7 * MIN + HOUR);
      expect(second).not.toBe(first);
    });
  });

  describe("R2 mode (SigV4 presign)", () => {
    it("two presigns of the same product key in the same window are IDENTICAL", async () => {
      const svc = new StorageService(r2Config());
      const first = await svc.presignedUrl(PRODUCT_KEY);
      jest.setSystemTime(T0 + 7 * MIN + 13_000);
      const second = await svc.presignedUrl(PRODUCT_KEY);
      jest.setSystemTime(T0 + 8 * HOUR);
      const third = await svc.presignedUrl(PRODUCT_KEY);

      expect(first).toContain("X-Amz-Signature=");
      expect(second).toBe(first);
      expect(third).toBe(first);
      // Same instant the local-disk URL expires at.
      expect(r2Validity(first).expiresAt).toBe(NOON);
    });

    it("a presign near the end of a window keeps ≥ 1 h of validity and is never dated in the future", async () => {
      const svc = new StorageService(r2Config());
      const nearBoundary = NOON - 30 * MIN;
      jest.setSystemTime(nearBoundary);
      const { signedAt, expiresAt, expiresIn } = r2Validity(await svc.presignedUrl(PRODUCT_KEY));

      expect(expiresAt - nearBoundary).toBeGreaterThanOrEqual(HOUR);
      expect(expiresAt).toBe(MIDNIGHT);
      // R2 rejects a request dated in the future, so the signing date must not be after "now".
      expect(signedAt).toBeLessThanOrEqual(nearBoundary);
      // SigV4 caps a presigned URL at 7 days.
      expect(expiresIn).toBeLessThanOrEqual(7 * 24 * 3600);
    });

    it("keeps a per-mint presign (signed now, minimum lifetime) for a mutable key", async () => {
      const svc = new StorageService(r2Config());
      const { signedAt, expiresIn } = r2Validity(
        await svc.presignedUrl("statement-pdfs/cust-1/2026-09.pdf"),
      );
      expect(signedAt).toBe(T0);
      expect(expiresIn).toBe(3600);
    });
  });
});
