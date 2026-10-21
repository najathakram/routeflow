import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import {
  PRODUCT_IMPORT_QUEUE,
  type ProductImportJobCounts,
  type ProductImportJobData,
  type ProductImportJobState,
  type ProductImportJobStatus,
} from "./product-import-job";

/** Bull's job states folded to the four the client shows. */
const STATE: Record<string, ProductImportJobState> = {
  completed: "done",
  failed: "failed",
  active: "running",
};

/**
 * SA-823 section 5: the queue behind a large family-import apply. `enqueue` stores the file with the tenant and actor;
 * `status` is tenant-scoped (another tenant's job id is a 404, never a peek).
 */
@Injectable()
export class ProductImportJobService {
  constructor(
    @InjectQueue(PRODUCT_IMPORT_QUEUE) private readonly queue: Queue<ProductImportJobData>,
    private readonly prisma: PrismaService,
  ) {}

  async enqueue(input: {
    userId: string;
    fileName?: string;
    buffer: Buffer;
  }): Promise<{ jobId: string }> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new NotFoundException("No tenant context");
    const job = await this.queue.add(
      "apply",
      {
        tenantId,
        userId: input.userId,
        fileName: input.fileName,
        fileBase64: input.buffer.toString("base64"),
      },
      // attempts 1: an error is not retried. Bull still re-runs a STALLED job once; that is safe because the apply
      // re-plans live from the file and is idempotent (a re-run shows the finished rows as unchanged).
      { attempts: 1, removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 48 * 3600 } },
    );
    return { jobId: String(job.id) };
  }

  async status(jobId: string): Promise<ProductImportJobStatus> {
    const tenantId = this.prisma.getTenantId();
    const job = await this.queue.getJob(jobId);
    if (!job || !tenantId || job.data.tenantId !== tenantId) {
      throw new NotFoundException("Import job not found");
    }
    const bull = await job.getState();
    const state = STATE[bull] ?? "queued";
    const progress = job.progress() as unknown;
    const data =
      progress !== null && typeof progress === "object"
        ? (progress as { percent?: number } & Partial<ProductImportJobCounts>)
        : null;
    return {
      id: String(job.id),
      state,
      progress: typeof progress === "number" ? progress : (data?.percent ?? 0),
      ...(data
        ? {
            counts: {
              created: data.created ?? 0,
              updated: data.updated ?? 0,
              unchanged: data.unchanged ?? 0,
              skipped: data.skipped ?? 0,
            },
          }
        : {}),
      ...(state === "done" ? { result: job.returnvalue as unknown } : {}),
      ...(state === "failed" ? { error: job.failedReason ?? "import failed" } : {}),
    };
  }
}
