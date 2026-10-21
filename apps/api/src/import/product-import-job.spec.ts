import { ConflictException, NotFoundException } from "@nestjs/common";
import { ProductImportJobService } from "./product-import-job.service";
import { ProductImportProcessor } from "./product-import.processor";
import { PRODUCT_IMPORT_QUEUE } from "./product-import-job";
import { TenantContextService } from "../tenant/tenant-context.service";

/** SA-823 section 5: the background apply of a large family import (queue, status, processor under the tenant context). */
describe("product import background job", () => {
  const job = (over: Record<string, unknown> = {}) => ({
    id: "7",
    data: { tenantId: "tenant-a", userId: "user-1", fileName: "f.csv", fileBase64: "" },
    progress: () => 42,
    getState: jest.fn(async () => "active"),
    returnvalue: undefined,
    failedReason: undefined,
    ...over,
  });

  describe("ProductImportJobService", () => {
    let queue: { add: jest.Mock; getJob: jest.Mock };
    let svc: ProductImportJobService;
    beforeEach(() => {
      queue = { add: jest.fn(async () => ({ id: "7" })), getJob: jest.fn(async () => job()) };
      svc = new (
        ProductImportJobService as unknown as new (
          q: unknown,
          p: unknown,
        ) => ProductImportJobService
      )(queue, { getTenantId: () => "tenant-a" });
    });

    it("enqueue stores the tenant, the actor, the file name and the file, and returns the job id", async () => {
      const out = await svc.enqueue({
        userId: "user-1",
        fileName: "f.csv",
        buffer: Buffer.from("a,b"),
      });
      expect(out).toEqual({ jobId: "7" });
      expect(queue.add).toHaveBeenCalledWith(
        "apply",
        {
          tenantId: "tenant-a",
          userId: "user-1",
          fileName: "f.csv",
          fileBase64: Buffer.from("a,b").toString("base64"),
        },
        expect.objectContaining({ attempts: 1 }),
      );
    });

    it("retains a failed job for 48 hours, not 7 days", async () => {
      await svc.enqueue({ userId: "user-1", buffer: Buffer.from("a") });
      expect(queue.add.mock.calls[0][2].removeOnFail).toEqual({ age: 48 * 3600 });
    });

    it("status maps the Bull state and carries progress, the result and the failure", async () => {
      expect(await svc.status("7")).toMatchObject({ id: "7", state: "running", progress: 42 });
      queue.getJob.mockResolvedValue(
        job({ getState: async () => "completed", returnvalue: { created: 1 } }),
      );
      expect(await svc.status("7")).toMatchObject({ state: "done", result: { created: 1 } });
      queue.getJob.mockResolvedValue(job({ getState: async () => "failed", failedReason: "boom" }));
      // a code, never the raw message: an unknown reason is the generic code
      const failed = await svc.status("7");
      expect(failed).toMatchObject({ state: "failed", errorCode: "IMPORT_JOB_FAILED" });
      expect(JSON.stringify(failed)).not.toContain("boom");
      queue.getJob.mockResolvedValue(
        job({ getState: async () => "failed", failedReason: "WORKSPACE_READ_ONLY" }),
      );
      expect(await svc.status("7")).toMatchObject({ errorCode: "WORKSPACE_READ_ONLY" });
      queue.getJob.mockResolvedValue(job({ getState: async () => "waiting" }));
      expect((await svc.status("7")).state).toBe("queued");
    });

    it("status carries the running counts from the progress data, so a failed job shows them", async () => {
      queue.getJob.mockResolvedValue(
        job({
          getState: async () => "failed",
          failedReason: "boom",
          progress: () => ({ percent: 60, created: 3, updated: 20, unchanged: 1, skipped: 2 }),
        }),
      );
      expect(await svc.status("7")).toMatchObject({
        state: "failed",
        progress: 60,
        counts: { created: 3, updated: 20, unchanged: 1, skipped: 2 },
      });
    });

    it("status is tenant-scoped: another tenant's job, or no job, is a 404", async () => {
      queue.getJob.mockResolvedValue(job({ data: { tenantId: "tenant-b" } }));
      await expect(svc.status("7")).rejects.toBeInstanceOf(NotFoundException);
      queue.getJob.mockResolvedValue(null);
      await expect(svc.status("9")).rejects.toBeInstanceOf(NotFoundException);
    });

    it("uses the product-import queue", () => {
      expect(PRODUCT_IMPORT_QUEUE).toBe("product-import");
    });
  });

  describe("ProductImportProcessor", () => {
    const build = (status: string | null = "ACTIVE") => {
      const tenantCtx = new TenantContextService();
      const seen: { tenant: string | null } = { tenant: null };
      const importService = {
        importProducts: jest.fn(async (_b: Buffer, _u: string, opts: any) => {
          seen.tenant = tenantCtx.getOrNull();
          opts.onProgress?.(0, 200, { created: 0, updated: 0, unchanged: 0, skipped: 0 });
          opts.onProgress?.(1, 200, { created: 0, updated: 1, unchanged: 0, skipped: 0 });
          opts.onProgress?.(2, 200, { created: 0, updated: 2, unchanged: 0, skipped: 0 });
          opts.onProgress?.(100, 200, { created: 1, updated: 99, unchanged: 0, skipped: 0 });
          return { created: 1 };
        }),
      };
      const prisma = {
        tenant: { findUnique: jest.fn(async () => (status ? { status } : null)) },
      };
      const proc = new (
        ProductImportProcessor as unknown as new (
          i: unknown,
          t: unknown,
          p: unknown,
        ) => ProductImportProcessor
      )(importService, tenantCtx, prisma);
      return { proc, importService, seen, prisma };
    };
    const jobWith = (over: Record<string, unknown> = {}): any => ({
      ...job({ progress: jest.fn(), update: jest.fn(async () => undefined) }),
      data: {
        tenantId: "tenant-a",
        userId: "user-1",
        fileName: "f.csv",
        fileBase64: Buffer.from("x").toString("base64"),
      },
      ...over,
    });

    it("runs the apply inside the job's tenant context, without background routing", async () => {
      const { proc, importService, seen } = build();
      const j = jobWith();
      const out = await proc.handle(j as never);
      expect(out).toEqual({ created: 1 });
      expect(seen.tenant).toBe("tenant-a");
      const opts = importService.importProducts.mock.calls[0][2];
      expect(opts.allowBackground).toBeUndefined();
      expect(opts.dryRun).toBeFalsy();
      expect(opts.fileName).toBe("f.csv");
      expect(importService.importProducts.mock.calls[0][0].toString()).toBe("x");
    });

    it("reports progress only when the percent moves (every 1%), with the running counts", async () => {
      const { proc } = build();
      const j = jobWith();
      await proc.handle(j as never);
      // 0/200 = 0%, 1/200 = 1% (0.5 rounds to 1), 2/200 = 1% again (skipped), 100/200 = 50%
      const calls = (j.progress as jest.Mock).mock.calls.map((c) => c[0]);
      expect(calls).toEqual([
        { percent: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 },
        { percent: 1, created: 0, updated: 1, unchanged: 0, skipped: 0 },
        { percent: 50, created: 1, updated: 99, unchanged: 0, skipped: 0 },
      ]);
    });

    it("clears the stored file once the job completes", async () => {
      const { proc } = build();
      const j = jobWith();
      await proc.handle(j as never);
      expect(j.update).toHaveBeenCalledWith(expect.objectContaining({ fileBase64: "" }));
    });

    it.each(["SUSPENDED", "CANCELLED", "READ_ONLY"])(
      "a %s workspace gets no writes: the job fails before importProducts runs",
      async (status) => {
        const { proc, importService } = build(status);
        await expect(proc.handle(jobWith() as never)).rejects.toThrow(/^WORKSPACE_READ_ONLY$/);
        expect(importService.importProducts).not.toHaveBeenCalled();
      },
    );

    it("a refusal from the import (an HTTP exception with a code) fails the job with THAT code, not its text", async () => {
      const { proc, importService } = build();
      importService.importProducts.mockRejectedValueOnce(
        new ConflictException({ code: "IMPORT_FAMILY_PRICING_ON", message: "raw sentence" }),
      );
      await expect(proc.handle(jobWith() as never)).rejects.toThrow(/^IMPORT_FAMILY_PRICING_ON$/);
    });

    it("any other failure is the generic code and never leaks its message", async () => {
      const { proc, importService } = build();
      importService.importProducts.mockRejectedValueOnce(new Error("secret db text"));
      await expect(proc.handle(jobWith() as never)).rejects.toThrow(/^IMPORT_JOB_FAILED$/);
    });

    it("a failed job.update (the file clean-up) does not fail an applied job", async () => {
      const { proc } = build();
      const j = jobWith({ update: jest.fn().mockRejectedValue(new Error("redis down")) });
      await expect(proc.handle(j as never)).resolves.toEqual({ created: 1 });
    });

    it("a missing tenant row gets no writes either", async () => {
      const { proc, importService } = build(null);
      await expect(proc.handle(jobWith() as never)).rejects.toThrow();
      expect(importService.importProducts).not.toHaveBeenCalled();
    });
  });
});
