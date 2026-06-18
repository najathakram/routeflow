import * as crypto from "crypto";

/**
 * F5-001: resolve the storage-URL HMAC signing secret WITHOUT reusing JWT_SECRET
 * verbatim. If STORAGE_URL_SIGNING_SECRET is set explicitly, use it. Otherwise
 * derive a cryptographically independent key from JWT_SECRET via HKDF-SHA256 with
 * a fixed domain-separation label. This removes the secret-reuse blast radius (a
 * disclosure of one secret no longer reveals the other) while requiring no new
 * env var and never crashing boot. Note: changing the derivation invalidates
 * any URLs signed before deploy; those expire within urlExpirySeconds (≤1h) and
 * are re-minted on the next page load.
 */
function resolveStorageSigningSecret(): string {
  const explicit = process.env.STORAGE_URL_SIGNING_SECRET;
  if (explicit) return explicit;
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

export interface AppConfig {
  nodeEnv: string;
  port: number;
  taxRate: number;
  database: {
    url: string;
  };
  jwt: {
    secret: string;
    refreshSecret: string;
    expiresIn: string;
    refreshExpiresIn: string;
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
    /** Lifetime in seconds for signed local-disk URLs. Default 1 hour. */
    urlExpirySeconds: number;
  };
  ors: {
    apiKey: string;
  };
  googleMaps: {
    apiKey: string;
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
    priceStarter: string;
    priceProfessional: string;
    priceEnterprise: string;
  };
}

export const configuration = (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "3000", 10),
  taxRate: parseFloat(process.env.TAX_RATE ?? "0.1"),
  database: {
    url: process.env.DATABASE_URL ?? "",
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? "",
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? "",
    expiresIn: process.env.JWT_EXPIRES_IN ?? "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "3d",
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
    urlExpirySeconds: parseInt(process.env.STORAGE_URL_EXPIRY_SECONDS ?? "3600", 10),
  },
  ors: {
    apiKey: process.env.ORS_API_KEY ?? "",
  },
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
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
    priceStarter: process.env.STRIPE_PRICE_STARTER ?? "",
    priceProfessional: process.env.STRIPE_PRICE_PROFESSIONAL ?? "",
    priceEnterprise: process.env.STRIPE_PRICE_ENTERPRISE ?? "",
  },
});
