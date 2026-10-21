import { Process, Processor } from "@nestjs/bull";
import { Injectable } from "@nestjs/common";
import type { Job } from "bull";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ImportService } from "./import.service";
import { PRODUCT_IMPORT_QUEUE, type ProductImportJobData } from "./product-import-job";

/**
 * SA-823 section 5: runs a queued family-import apply. It calls the SAME importProducts a synchronous apply does, under the
 * job's tenant context, WITHOUT background routing (no allowBackground), so the per-row writers, every guard and the
 * summary audit row are unchanged. The result is the job's return value.
 */
@Injectable()
@Processor(PRODUCT_IMPORT_QUEUE)
export class ProductImportProcessor {
  constructor(
    private readonly importService: ImportService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  @Process("apply")
  async handle(job: Job<ProductImportJobData>): Promise<unknown> {
    const { tenantId, userId, fileName, fileBase64 } = job.data;
    return this.tenantCtx.run(tenantId, () =>
      this.importService.importProducts(Buffer.from(fileBase64, "base64"), userId, {
        fileName,
        onProgress: (done, total) => {
          void job.progress(total > 0 ? Math.round((done * 100) / total) : 100);
        },
      }),
    );
  }
}
