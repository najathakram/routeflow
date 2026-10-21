import { NotFoundException } from "@nestjs/common";
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

    it("status maps the Bull state and carries progress, the result and the failure", async () => {
      expect(await svc.status("7")).toMatchObject({ id: "7", state: "running", progress: 42 });
      queue.getJob.mockResolvedValue(
        job({ getState: async () => "completed", returnvalue: { created: 1 } }),
      );
      expect(await svc.status("7")).toMatchObject({ state: "done", result: { created: 1 } });
      queue.getJob.mockResolvedValue(job({ getState: async () => "failed", failedReason: "boom" }));
      expect(await svc.status("7")).toMatchObject({ state: "failed", error: "boom" });
      queue.getJob.mockResolvedValue(job({ getState: async () => "waiting" }));
      expect((await svc.status("7")).state).toBe("queued");
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
    it("runs the apply inside the job's tenant context, without background routing, and reports progress", async () => {
      const tenantCtx = new TenantContextService();
      let seenTenant: string | null = null;
      const importService = {
        importProducts: jest.fn(async (_b: Buffer, _u: string, opts: any) => {
          seenTenant = tenantCtx.getOrNull();
          opts.onProgress?.(5, 10);
          return { created: 1 };
        }),
      };
      const progress = jest.fn();
      const proc = new (
        ProductImportProcessor as unknown as new (i: unknown, t: unknown) => ProductImportProcessor
      )(importService, tenantCtx);
      const out = await proc.handle({
        ...job({ progress }),
        data: {
          tenantId: "tenant-a",
          userId: "user-1",
          fileName: "f.csv",
          fileBase64: Buffer.from("x").toString("base64"),
        },
      } as never);
      expect(out).toEqual({ created: 1 });
      expect(seenTenant).toBe("tenant-a");
      const opts = importService.importProducts.mock.calls[0][2];
      expect(opts.allowBackground).toBeUndefined();
      expect(opts.dryRun).toBeFalsy();
      expect(opts.fileName).toBe("f.csv");
      expect(importService.importProducts.mock.calls[0][0].toString()).toBe("x");
      expect(progress).toHaveBeenCalledWith(50);
    });
  });
});
