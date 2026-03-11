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
  ors: {
    apiKey: string;
  };
  googleMaps: {
    apiKey: string;
  };
  fcm: {
    projectId: string;
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
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? "7d",
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
  ors: {
    apiKey: process.env.ORS_API_KEY ?? "",
  },
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
  },
  fcm: {
    projectId: process.env.FCM_PROJECT_ID ?? "",
  },
});
