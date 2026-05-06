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

// Presigned GET URL expiry: 1 hour
const GET_EXPIRY_SECONDS = 3600;

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

  constructor(private readonly config: ConfigService) {
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
   *  the user's JWT bearer token). */
  async presignedUrl(key: string): Promise<string> {
    if (this.useLocal) {
      const expirySeconds =
        this.config.get<number>("storage.urlExpirySeconds") ?? GET_EXPIRY_SECONDS;
      const expiresAt = Date.now() + expirySeconds * 1000;
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

    return getSignedUrl(this.s3!, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: GET_EXPIRY_SECONDS,
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
