import * as crypto from "crypto";
import { webBaseUrl } from "./web-base-url";

/**
 * F5-001: resolve the storage-URL HMAC signing secret WITHOUT reusing JWT_SECRET
 * verbatim. If STORAGE_URL_SIGNING_SECRET is set explicitly, use it. Otherwise
 * derive a cryptographically independent key from JWT_SECRET via HKDF-SHA256 with
 * a fixed domain-separation label. This removes the secret-reuse blast radius (a
 * disclosure of one secret no longer reveals the other) while requiring no new
 * env var and never crashing boot. Note: changing the derivation invalidates
 * any URLs signed before deploy at once (their signatures stop verifying); they
 * are re-minted on the next page load, and product images re-fetch a fresh URL
 * on their own when one fails to load (#2091).
 */
function resolveStorageSigningSecret(): string {
  const explicit = process.env.STORAGE_URL_SIGNING_SECRET;
  if (explicit) return explicit;
  // F5-001: never fall back to a JWT_SECRET-derived key in production — a JWT_SECRET
  // leak would otherwise let an attacker forge storage-access signatures. bootstrap's
  // assertSecrets() already exits when it's unset in prod; this is defense-in-depth
  // for any other entry point (scripts, workers) that loads config without that guard.
  if ((process.env.NODE_ENV ?? "") === "production") {
    throw new Error(
      "STORAGE_URL_SIGNING_SECRET must be set in production (it is never derived from JWT_SECRET).",
    );
  }
  const jwtSecret = process.env.JWT_SECRET ?? "";
  if (!jwtSecret) return "";
  const derived = crypto.hkdfSync(
    "sha256",
    Buffer.from(jwtSecret, "utf8"),
    Buffer.alloc(0),
    Buffer.from("routeflow:storage-url-signing:v1", "utf8"),
    32,
  );
  return Buffer.from(derived).toString("hex");
}

/**
 * A positive whole number from the environment, or `fallback` when the variable is unset, blank
 * or anything else ("abc", "-5", "1.5", "0"). `parseInt` alone let a typo through as NaN, which
 * StorageService then signed into every URL as `expires=NaN` — an unverifiable link.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  database: {
    url: string;
  };
  jwt: {
    secret: string;
    refreshSecret: string;
    expiresIn: string;
    refreshExpiresIn: string;
  };
  /** Public base URLs per client surface — used to build links in outbound
   *  emails (password reset). Server-side mapping only; client-supplied URLs
   *  must never reach an email. */
  urls: {
    web: string;
    mobileWeb: string;
  };
  redis: {
    url: string;
    password: string;
  };
  zoho: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucketName: string;
  };
  uploadDir: string;
  storage: {
    /** Secret used to HMAC-sign local-disk presigned URLs. Derived from JWT_SECRET via HKDF when not set explicitly (F5-001). */
    urlSigningSecret: string;
    /**
     * Minimum lifetime in seconds of a signed storage URL (local disk and R2), default 1 hour.
     * A per-mint URL (every key that is not write-once) lives exactly this long; a stable
     * product-image URL always has at least this much left when it is minted (#2091).
     */
    urlExpirySeconds: number;
    /**
     * Window in seconds that stable product-image URLs are bucketed to, default 12 hours: every
     * mint of one key inside a window returns the identical URL, so the browser cache hits
     * (#2091). See StorageService.presignedUrl.
     */
    stableUrlWindowSeconds: number;
  };
  throttle: {
    /**
     * Per-IP ceiling (requests / 60 s) for GET /uploads/*, which is exempt from the global
     * 100 / 60 s throttle because one catalog page loads more images than that (#2091).
     */
    uploadsLimit: number;
  };
  ors: {
    apiKey: string;
  };
  googleMaps: {
    apiKey: string;
  };
  apple: {
    bundleId: string;
    teamId: string;
    keyId: string;
    privateKey: string;
  };
  mapbox: {
    accessToken: string;
  };
  fcm: {
    projectId: string;
  };
  stripe: {
    secretKey: string;
    webhookSecret: string;
    /** Connect platform client id (ca_…) — tenant-account OAuth linking. */
    connectClientId: string;
    /** Signing secret of the "events on connected accounts" webhook endpoint. */
    connectWebhookSecret: string;
  };
}

export const configuration = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "3000", 10),
  database: {
    url: process.env.DATABASE_URL ?? "",
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? "",
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? "",
    expiresIn: process.env.JWT_EXPIRES_IN ?? "15m",
    // 30-day idle cutoff: refresh rotation re-mints a fresh expiry on every
    // use, so active sessions slide forward indefinitely; only 30 days of
    // inactivity forces a re-login. Web presence-cookie max-age
    // (apps/web/lib/presence-cookies.ts) must track this value.
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "30d",
  },
  urls: {
    web: webBaseUrl(),
    mobileWeb: process.env.MOBILE_WEB_URL ?? "https://routeflowmobile-production.up.railway.app",
  },
  redis: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    password: process.env.REDIS_PASSWORD ?? "",
  },
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID ?? "",
    clientSecret: process.env.ZOHO_CLIENT_SECRET ?? "",
    refreshToken: process.env.ZOHO_REFRESH_TOKEN ?? "",
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucketName: process.env.R2_BUCKET_NAME ?? "routeflow-assets",
  },
  uploadDir: process.env.UPLOAD_DIR ?? "",
  storage: {
    urlSigningSecret: resolveStorageSigningSecret(),
    urlExpirySeconds: positiveIntEnv("STORAGE_URL_EXPIRY_SECONDS", 3600),
    stableUrlWindowSeconds: positiveIntEnv("STORAGE_URL_STABLE_WINDOW_SECONDS", 43_200),
  },
  throttle: {
    uploadsLimit: positiveIntEnv("UPLOADS_THROTTLE_LIMIT", 1200),
  },
  ors: {
    apiKey: process.env.ORS_API_KEY ?? "",
  },
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
  },
  // #2309 (SA-418): Sign in with Apple, native iOS only. Read directly by name via the
  // untyped ConfigService (AppleOAuthService.isConfigured()), same pattern as GOOGLE_CLIENT_ID —
  // not consumed through this "apple" object, but declared here so every config name the app
  // reads has one place naming it.
  apple: {
    bundleId: process.env.APPLE_BUNDLE_ID ?? "",
    teamId: process.env.APPLE_TEAM_ID ?? "",
    keyId: process.env.APPLE_KEY_ID ?? "",
    privateKey: process.env.APPLE_PRIVATE_KEY ?? "",
  },
  mapbox: {
    accessToken: process.env.MAPBOX_ACCESS_TOKEN ?? "",
  },
  fcm: {
    projectId: process.env.FCM_PROJECT_ID ?? "",
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    connectClientId: process.env.STRIPE_CONNECT_CLIENT_ID ?? "",
    connectWebhookSecret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? "",
  },
});
