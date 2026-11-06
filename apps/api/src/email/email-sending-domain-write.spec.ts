/**
 * SA-1105 Q6, rows E-1 / E-2: `EmailService.writeSendingDomainConfig` writes through `SystemConfigService.set`, the one
 * config-write home. Before, it ran its own find-then-update through `forTenant()`, which is the UNSCOPED client when no
 * business is in context: a tenantless caller could find and rewrite ANOTHER business's `email.sendingDomain` row.
 * The real EmailService method and the real SystemConfigService run against a fake two-business table.
 */
import { EmailService } from "./email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

const KEY = "email.sendingDomain";

function world(tenantId: string | null) {
  const rows = [
    { id: "row-a", tenantId: "tenant-a", key: KEY, value: '{"domain":"a.example"}' },
    { id: "row-b", tenantId: "tenant-b", key: KEY, value: '{"domain":"b.example"}' },
  ];
  const scope = (where: any) =>
    rows.filter((r) => r.key === where.key && (tenantId === null || r.tenantId === tenantId));
  const systemConfig = {
    findFirst: jest.fn(async ({ where }: any) => scope(where)[0] ?? null),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    create: jest.fn(async ({ data }: any) => {
      rows.push({ id: "new", tenantId: tenantId as string, ...data });
      return data;
    }),
  };
  const prisma = { getTenantId: () => tenantId, forTenant: () => ({ systemConfig }) } as any;
  const encryption = { encrypt: (v: string) => v, decrypt: (v: string) => v } as any;
  const host = { prisma, systemConfig: new SystemConfigService(prisma, encryption) };
  const write = (cfg: object | null) =>
    (EmailService.prototype as any).writeSendingDomainConfig.call(host, cfg);
  return { rows, systemConfig, write };
}

describe("E-1 a tenantless writeSendingDomainConfig", () => {
  it("refuses with the coded config error, runs no query, and leaves every business's row unchanged", async () => {
    const { rows, systemConfig, write } = world(null);
    const before = JSON.stringify(rows);
    await expect(write({ domain: "evil.example" })).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.SYSTEM_CONFIG_TENANT_REQUIRED },
    });
    expect(systemConfig.findFirst).not.toHaveBeenCalled();
    expect(systemConfig.update).not.toHaveBeenCalled();
    expect(systemConfig.create).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("E-2 the tenant path stores the same value as before", () => {
  it("updates the business's own row with JSON.stringify(cfg), and a null cfg stores the string null", async () => {
    const { rows, systemConfig, write } = world("tenant-a");
    await write({ domain: "mail.a.example", status: "pending" });
    expect(systemConfig.update).toHaveBeenCalledWith({
      where: { id: "row-a" },
      data: { value: '{"domain":"mail.a.example","status":"pending"}' },
    });
    expect(rows.find((r) => r.id === "row-b")!.value).toBe('{"domain":"b.example"}');
    await write(null);
    expect(rows.find((r) => r.id === "row-a")!.value).toBe("null");
  });

  it("creates the row when the business has none", async () => {
    const { systemConfig, write } = world("tenant-c");
    await write({ domain: "c.example" });
    expect(systemConfig.create).toHaveBeenCalledWith({
      data: { key: KEY, value: '{"domain":"c.example"}' },
    });
  });
});
