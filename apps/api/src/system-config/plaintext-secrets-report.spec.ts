import { Logger } from "@nestjs/common";
import { PlaintextSecretsReport } from "./plaintext-secrets-report.service";

/**
 * SA-1102 PR-A §2.5 (S-11): the boot report is read-only and never blocks boot. One ERROR line names the secret keys
 * that hold a plaintext value and how many, with no value and no tenant id; a failed count logs a WARN and boot goes on.
 */
describe("PlaintextSecretsReport (SA-1102 S-11)", () => {
  let errors: jest.SpyInstance;
  let warns: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    warns = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const withRows = (rows: Array<Array<{ key: string; n: number }>>) => {
    const queue = [...rows];
    const prisma = { $queryRaw: jest.fn(async () => queue.shift() ?? []) };
    return { prisma, report: new PlaintextSecretsReport(prisma as any) };
  };

  it("one plaintext SystemConfig secret: one ERROR line with the key and the count, nothing else", async () => {
    const { report } = withRows([[{ key: "anthropic.apiKey", n: 1 }], []]);
    await report.run();
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0][0]);
    expect(line).toBe(
      "plaintext secrets at rest: SystemConfig {anthropic.apiKey: 1}; PlatformConfig {}",
    );
    expect(line).not.toMatch(/sk-|tenant/i);
  });

  it("a plaintext PlatformConfig secret is named too", async () => {
    const { report } = withRows([[], [{ key: "claude.apiKey", n: 1 }]]);
    await report.run();
    expect(String(errors.mock.calls[0][0])).toBe(
      "plaintext secrets at rest: SystemConfig {}; PlatformConfig {claude.apiKey: 1}",
    );
  });

  it("nothing plaintext: no ERROR line", async () => {
    const { report } = withRows([[], []]);
    await report.run();
    expect(errors).not.toHaveBeenCalled();
  });

  it("a failed count logs a WARN and never throws", async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const report = new PlaintextSecretsReport(prisma as any);
    await expect(report.run()).resolves.toBeUndefined();
    expect(warns).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("onApplicationBootstrap does not wait for the count and never throws", async () => {
    const prisma = { $queryRaw: jest.fn(() => new Promise(() => undefined)) };
    const report = new PlaintextSecretsReport(prisma as any);
    await expect(report.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
