import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Default minimum lifetime of a signed URL (`storage.urlExpirySeconds`): 1 hour. */
const DEFAULT_MIN_LIFETIME_SECONDS = 3600;
/** Default window stable URLs are bucketed to (`storage.stableUrlWindowSeconds`): 12 hours. */
const DEFAULT_STABLE_WINDOW_SECONDS = 12 * 3600;
/**
 * Upper bound for either setting. Two of them (window + minimum lifetime, the longest a stable
 * URL can live) stay under SigV4's 7-day cap on a presigned URL, so R2 mode can always sign.
 */
const MAX_LIFETIME_SETTING_SECONDS = 3 * 24 * 3600;
/** Lower bound for the window: a shorter one would defeat the cache it exists for. */
const MIN_STABLE_WINDOW_SECONDS = 60;

/**
 * Key prefixes whose objects are WRITE-ONCE: every upload mints a fresh key and nothing ever
 * rewrites an existing one (`products.service.uploadImage` names each image
 * `products/<productId>/<randomUUID>[-fp<X>x<Y>].<ext>`; deleting removes the key). Only these
 * keys get a stable URL (#2091). A stable URL plus the uploads route's
 * `Cache-Control: immutable` would pin a stale copy of any key that IS rewritten in place — the
 * tenant logo (`tenants/<id>/logo.<ext>`), a payment image, a statement or invoice PDF — so
 * everything else keeps a per-mint URL. Adding a prefix here requires that its writer never
 * reuses a key.
 */
export const STABLE_URL_KEY_PREFIXES: readonly string[] = ["products/"];

/** True when `key` is write-once and so may be served from a stable, cacheable URL. */
export function hasStableUrl(key: string): boolean {
  return STABLE_URL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Expiry (ms epoch) of a stable URL minted at `nowMs`: the end of the first epoch-aligned
 * `windowMs` window that still leaves at least `minLifetimeMs` of validity. Every mint in
 * ((k−1)·W − F, k·W − F] returns k·W, so one key's URL stays byte-identical for a whole window
 * (the browser cache hits), and a mint in a window's last F rolls to the next window's end —
 * the very URL that window hands out — so no URL is ever minted with less than F left.
 */
export function stableExpiryMs(nowMs: number, windowMs: number, minLifetimeMs: number): number {
  return Math.ceil((nowMs + minLifetimeMs) / windowMs) * windowMs;
}

/** Whole seconds within [min, max]; anything else (unset, NaN, ≤ 0, fractional) → `fallback`. */
function secondsSetting(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * HMAC-sign a storage key + expiry so the URL can be loaded by browser
 * `<img>` tags cross-origin without sending the user's JWT. Mirrors how
 * S3/R2 presigned URLs work; verified by `verifyLocalUrlSignature` in the
 * uploads controller.
 */
export function signLocalUrl(secret: string, key: string, expiresAt: number): string {
  const payload = `${key}|${expiresAt}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Constant-time compare returning true iff the signature is valid AND not expired. */
export function verifyLocalUrlSignature(
  secret: string,
  key: string,
  expiresAt: number,
  providedSig: string,
): boolean {
  if (!secret || !providedSig || !Number.isFinite(expiresAt)) return false;
  if (Date.now() > expiresAt) return false;
  const expected = signLocalUrl(secret, key, expiresAt);
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

@Injectable()
export class StorageService {
  private readonly s3: S3Client | null;
  private readonly bucket: string;
  /** Minimum lifetime of any signed URL, in seconds (exact lifetime of a per-mint URL). */
  private readonly minLifetimeSeconds: number;
  /** Window stable URLs are bucketed to, in seconds. */
  private readonly stableWindowSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.minLifetimeSeconds = secondsSetting(
      config.get<number>("storage.urlExpirySeconds"),
      DEFAULT_MIN_LIFETIME_SECONDS,
      1,
      MAX_LIFETIME_SETTING_SECONDS,
    );
    this.stableWindowSeconds = secondsSetting(
      config.get<number>("storage.stableUrlWindowSeconds"),
      DEFAULT_STABLE_WINDOW_SECONDS,
      MIN_STABLE_WINDOW_SECONDS,
      MAX_LIFETIME_SETTING_SECONDS,
    );
    const accountId = config.get<string>("r2.accountId") ?? "";
    const accessKeyId = config.get<string>("r2.accessKeyId") ?? "";
    const secretAccessKey = config.get<string>("r2.secretAccessKey") ?? "";
    this.bucket = config.get<string>("r2.bucketName") ?? "routeflow-assets";

    if (accountId && accessKeyId && secretAccessKey) {
      this.s3 = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
    } else {
      this.s3 = null;
      console.warn(
        "⚠️  R2 credentials not configured — falling back to local disk storage. " +
          "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY to use Cloudflare R2.",
      );
    }
  }

  private get useLocal(): boolean {
    return this.s3 === null;
  }

  /** Root directory for local uploads (overridable via UPLOAD_DIR env var).
   *  Defaults to os.tmpdir()/routeflow-uploads — always writable on every platform
   *  including Railway, where the /app directory is read-only. */
  private get uploadDir(): string {
    const configured = this.config.get<string>("uploadDir");
    return configured || path.join(os.tmpdir(), "routeflow-uploads");
  }

  /**
   * Public base URL used to construct local-file URLs.
   * Railway sets RAILWAY_PUBLIC_DOMAIN automatically; fall back to localhost.
   */
  private get publicBaseUrl(): string {
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (railwayDomain) return `https://${railwayDomain}`;
    const port = this.config.get<number>("port") ?? 3000;
    return `http://localhost:${port}`;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /** Upload a file buffer. Returns the stored object key. */
  async upload(key: string, buffer: Buffer, contentType: string): Promise<string> {
    if (this.useLocal) {
      const dest = path.join(this.uploadDir, key);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buffer);
      return key;
    }

    await this.s3!.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return key;
  }

  /** Delete an object by key. */
  async delete(key: string): Promise<void> {
    if (this.useLocal) {
      const dest = path.join(this.uploadDir, key);
      await fs.unlink(dest).catch(() => {}); // ignore if already gone
      return;
    }

    await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Return a URL to retrieve the file (presigned R2 URL or local API URL).
   *  Local-disk URLs include an HMAC signature in the query string so they
   *  can be loaded by browser `<img>` tags cross-origin (which can't send
   *  the user's JWT bearer token).
   *
   *  Expiry (#2091): a write-once key (`hasStableUrl`) gets a STABLE URL — its expiry is
   *  bucketed with `stableExpiryMs`, so every mint inside one window is byte-identical and the
   *  browser serves repeat views from cache instead of re-downloading every image on every page
   *  view. Any other key keeps a per-mint URL that lives exactly the minimum lifetime. The
   *  signature scheme and its verification are unchanged; only the expiry value differs. */
  async presignedUrl(key: string): Promise<string> {
    const nowMs = Date.now();
    const stable = hasStableUrl(key);
    const minLifetimeMs = this.minLifetimeSeconds * 1000;
    const expiresAt = stable
      ? stableExpiryMs(nowMs, this.stableWindowSeconds * 1000, minLifetimeMs)
      : nowMs + minLifetimeMs;

    if (this.useLocal) {
      const secret = this.config.get<string>("storage.urlSigningSecret") ?? "";
      const base = `${this.publicBaseUrl}/api/v1/uploads/${key}`;
      if (!secret) {
        // No signing secret configured — fall back to the unsigned URL.
        // The uploads controller will reject this without a JWT, which is
        // the safer default than emitting an unverifiable signature.
        return base;
      }
      const sig = signLocalUrl(secret, key, expiresAt);
      return `${base}?expires=${expiresAt}&sig=${sig}`;
    }

    // SigV4: a presigned URL is valid from X-Amz-Date for X-Amz-Expires seconds, and both are
    // part of the URL. For a stable URL the signing date is pinned to the earliest instant its
    // window can be minted in (expiry − window − minimum lifetime), so every mint in the window
    // signs identical bytes and no URL is ever dated in the future (R2 refuses those). A
    // per-mint URL is signed now for exactly the minimum lifetime.
    const lifetimeSeconds = stable
      ? this.stableWindowSeconds + this.minLifetimeSeconds
      : this.minLifetimeSeconds;
    return getSignedUrl(this.s3!, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: lifetimeSeconds,
      signingDate: new Date(expiresAt - lifetimeSeconds * 1000),
    });
  }

  /** Return URLs for an array of keys. */
  async presignedUrls(keys: string[]): Promise<string[]> {
    return Promise.all(keys.map((k) => this.presignedUrl(k)));
  }

  /** Download a stored object and return it as a Buffer. */
  async download(key: string): Promise<Buffer> {
    if (this.useLocal) {
      const dest = path.join(this.uploadDir, key);
      return fs.readFile(dest);
    }

    const response = await this.s3!.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const stream = response.Body as any;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
