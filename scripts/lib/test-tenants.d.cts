export declare const TEST_TENANT_SLUGS: Set<string>;
export declare const TEST_TENANT_PATTERN: RegExp;
export declare function isTestTenant(slug: unknown): boolean;
export declare function assertTestTenant(slug: unknown, context?: string): string;
