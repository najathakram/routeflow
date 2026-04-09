import { Injectable } from "@nestjs/common";
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
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const keyHex = this.configService.get<string>("ENCRYPTION_KEY") ?? "";
    if (keyHex.length !== 64) {
      // In dev/test without key, use a deterministic fallback (NOT for production)
      this.key = crypto.createHash("sha256").update("routeflow-dev-key-placeholder").digest();
    } else {
      this.key = Buffer.from(keyHex, "hex");
    }
  }

  encrypt(plaintext: string): string {
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
