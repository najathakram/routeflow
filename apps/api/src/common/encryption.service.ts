import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts/decrypts sensitive strings at rest using AES-256-GCM.
 * Storage format: IV_HEX:AUTH_TAG_HEX:CIPHERTEXT_BASE64
 * Key source: ENCRYPTION_KEY env var (32-byte hex string, 64 hex chars).
 */
@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;
  /**
   * F5-002: true when ENCRYPTION_KEY is missing/invalid and we fell back to the
   * publicly-known dev placeholder. In production this must NOT be used to write
   * new secrets (anyone with the source can derive the key), so encrypt() throws.
   * We deliberately do NOT crash on boot (the app may never touch encryption) and
   * keep decrypt() functional so any already-stored values remain readable.
   */
  private readonly usingInsecureFallback: boolean;
  private readonly isProduction: boolean;

  constructor(private readonly configService: ConfigService) {
    const keyHex = this.configService.get<string>("ENCRYPTION_KEY") ?? "";
    this.isProduction =
      (this.configService.get<string>("nodeEnv") ?? process.env.NODE_ENV) === "production";
    if (keyHex.length !== 64) {
      // In dev/test without key, use a deterministic fallback (NOT for production)
      this.usingInsecureFallback = true;
      this.key = crypto.createHash("sha256").update("routeflow-dev-key-placeholder").digest();
      if (this.isProduction) {
        this.logger.error(
          "ENCRYPTION_KEY is not set to a 64-char hex string in production. " +
            "Encrypting new secrets is DISABLED until it is configured. " +
            "Set ENCRYPTION_KEY in the Railway environment.",
        );
      }
    } else {
      this.usingInsecureFallback = false;
      this.key = Buffer.from(keyHex, "hex");
    }
  }

  encrypt(plaintext: string): string {
    // F5-002: never persist secrets under the guessable placeholder key in prod.
    if (this.usingInsecureFallback && this.isProduction) {
      throw new Error(
        "ENCRYPTION_KEY must be set to a 64-char hex string before encrypting secrets in production.",
      );
    }
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("base64")}`;
  }

  decrypt(stored: string): string {
    const [ivHex, authTagHex, ciphertextBase64] = stored.split(":");
    if (!ivHex || !authTagHex || !ciphertextBase64) {
      throw new Error("Invalid encrypted value format");
    }
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(ciphertextBase64, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
  }

  /** Returns null if value is null/undefined, otherwise decrypts */
  decryptNullable(stored: string | null | undefined): string | null {
    if (!stored) return null;
    return this.decrypt(stored);
  }
}
