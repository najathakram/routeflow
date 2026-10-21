import { Process, Processor } from "@nestjs/bull";
import { Injectable, Logger } from "@nestjs/common";
import type { Job } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { acceptsAutomatedWrites } from "../tenant/tenant-automation";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ImportService } from "./import.service";
import { PRODUCT_IMPORT_QUEUE, type ProductImportJobData } from "./product-import-job";

/**
 * SA-823 section 5: runs a queued family-import apply. It calls the SAME importProducts a synchronous apply does, under the
 * job's tenant context, WITHOUT background routing (no allowBackground), so the per-row writers, every guard and the
 * summary audit row are unchanged. The result is the job's return value.
 *
 * Like the invoice processor it checks the workspace first: only a TRIAL or ACTIVE workspace takes writes, so a suspended,
 * cancelled or read-only one gets none (the job fails with a plain message the page shows).
 */
@Injectable()
@Processor(PRODUCT_IMPORT_QUEUE)
export class ProductImportProcessor {
  private readonly logger = new Logger(ProductImportProcessor.name);

  constructor(
    private readonly importService: ImportService,
    private readonly tenantCtx: TenantContextService,
    private readonly prisma: PrismaService,
  ) {}

  @Process("apply")
  async handle(job: Job<ProductImportJobData>): Promise<unknown> {
    const { tenantId, userId, fileName, fileBase64 } = job.data;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (!tenant || !acceptsAutomatedWrites(tenant.status)) {
      this.logger.warn(`Refusing product-import job ${job.id}: tenant ${tenantId} takes no writes`);
      throw new Error("This workspace can't make changes right now, so the import didn't run.");
    }
    // report only when the percent moves (every 1%), with the running counts, so a failed job still shows how far it got
    let lastPercent = -1;
    const result = await this.tenantCtx.run(tenantId, () =>
      this.importService.importProducts(Buffer.from(fileBase64, "base64"), userId, {
        fileName,
        onProgress: (done, total, counts) => {
          const percent = total > 0 ? Math.round((done * 100) / total) : 100;
          if (percent === lastPercent) return;
          lastPercent = percent;
          void job.progress({ percent, ...counts });
        },
      }),
    );
    // the file is no longer needed once the job is done; keep the result, drop the bytes
    await job.update({ ...job.data, fileBase64: "" });
    return result;
  }
}
