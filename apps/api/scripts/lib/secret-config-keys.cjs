// The ONE list of config keys whose value is a secret (encrypted at rest), as the owner-run scripts see it: the read-only
// plaintext report and `encrypt-legacy-secrets`. They mirror SECRET_KEYS (system-config.service.ts) and
// PLATFORM_SECRET_KEYS (platform-config.service.ts); `secret-keys.pin.spec.ts` fails if they drift apart.
//
// Static exports only, so the .mjs scripts can `import { ... } from "./lib/secret-config-keys.cjs"`.

"use strict";

const SYSTEM_CONFIG_SECRET_KEYS = [
  "email.smtpPassword",
  "anthropic.apiKey",
  "zoho.clientSecret",
  "zoho.refreshToken",
];
const PLATFORM_CONFIG_SECRET_KEYS = ["claude.apiKey"];
// Same pattern as ENCRYPTED_FORMAT in apps/api/src/common/secret-at-rest.ts (POSIX-compatible).
const CIPHER_SHAPE = "^[0-9a-f]{32}:[0-9a-f]{32}:[A-Za-z0-9+/=]+$";

module.exports = { SYSTEM_CONFIG_SECRET_KEYS, PLATFORM_CONFIG_SECRET_KEYS, CIPHER_SHAPE };
