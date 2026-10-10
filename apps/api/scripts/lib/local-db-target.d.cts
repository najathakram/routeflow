export declare const LOCAL_DB_HOSTS: string[];
export declare function isLocalDbTarget(dbUrl: unknown): boolean;
export declare function localConnectionConfig(dbUrl: unknown): {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
} | null;
