import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { acceptsRecordKeeping } from "../tenant/tenant-automation";
import { InvoiceService } from "./invoice.service";

export interface GenerateInvoiceJobData {
  transactionId: string;
  tenantId: string;
}

@Processor("invoices")
export class InvoiceProcessor {
  private readonly logger = new Logger(InvoiceProcessor.name);

  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly prisma: PrismaService,
  ) {}

  @Process("generate-invoice")
  async handleGenerateInvoice(job: Job<GenerateInvoiceJobData>): Promise<void> {
    const { transactionId, tenantId } = job.data;
    // SA-776: the PDF of an EXISTING transaction is record-keeping - it keeps running while the workspace is
    // READ_ONLY, and is skipped (completed, never thrown, so Bull does not retry it) for a SUSPENDED or
    // CANCELLED tenant. A missing tenant row falls through to the service's own tenant guard (REG-B188).
    // Nothing enqueues generate-invoice today (OrdersService injects the queue but never adds to it). A future
    // producer must DELAY or REGENERATE for a suspended tenant rather than rely on this skip, or the PDF is lost
    // after the tenant is reactivated.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant && !acceptsRecordKeeping(tenant.status)) {
      this.logger.warn(
        `Skipping generate-invoice for transaction ${transactionId}: tenant ${tenantId} is ${tenant.status}`,
      );
      return;
    }
    this.logger.log(`Processing generate-invoice job for transaction ${transactionId}`);

    try {
      await this.invoiceService.generateInvoicePdf(transactionId, tenantId);
      this.logger.log(`Invoice PDF generated successfully for transaction ${transactionId}`);
    } catch (err: unknown) {
      this.logger.error(
        `Failed to generate invoice PDF for transaction ${transactionId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err; // Re-throw so Bull retries the job
    }
  }
}
