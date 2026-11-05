/**
 * The one implementation of "a secret config value is encrypted at rest" (SA-1102 §2.1). Both config stores
 * (`SystemConfigService`, per business, and `PlatformConfigService`, platform wide) call these with their own secret
 * set; the cipher shape and the crypto live here and in `EncryptionService`, nowhere else.
 */

/** AES-256-GCM storage shape from EncryptionService: IV_HEX:TAG_HEX:CIPHERTEXT_B64. */
export const ENCRYPTED_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$/;

/** The part of EncryptionService the helpers need (a spec can pass a stub). */
export interface SecretCipher {
  encrypt(plaintext: string): string;
  decrypt(stored: string): string;
}

/** Only a non-empty secret is encrypted: the empty string is the "cleared" sentinel. */
export function encryptIfSecret(
  secrets: ReadonlySet<string>,
  cipher: SecretCipher,
  key: string,
  value: string,
): string {
  return value && secrets.has(key) ? cipher.encrypt(value) : value;
}

/**
 * Decrypts a secret value that has the cipher shape. A legacy row written before encryption is plaintext (it does not
 * match the shape) and passes through, so an existing key keeps working until it is re-saved; that pass-through ends in
 * the follow-up after `encrypt-legacy-secrets.mjs` (SA-1102 §4). A value that has the shape but will not decrypt reads
 * as null and `onFailure` is told (the caller logs the key name, never the value).
 */
export function decryptIfSecret(
  secrets: ReadonlySet<string>,
  cipher: SecretCipher,
  key: string,
  value: string | null,
  onFailure?: () => void,
): string | null {
  if (!value || !secrets.has(key)) return value;
  if (!ENCRYPTED_FORMAT.test(value)) return value;
  try {
    return cipher.decrypt(value);
  } catch {
    onFailure?.();
    return null;
  }
}

/** What a client or admin screen may show of a secret: the last 4 characters and nothing else (`…abcd`). */
export function secretPreview(secret: string | null | undefined): string | null {
  return secret ? `…${secret.slice(-4)}` : null;
}
