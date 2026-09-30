import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { InvoiceService } from "./invoice.service";

export interface GenerateInvoiceJobData {
  transactionId: string;
  tenantId: string;
}

@Processor("invoices")
export class InvoiceProcessor {
  private readonly logger = new Logger(InvoiceProcessor.name);

  constructor(private readonly invoiceService: InvoiceService) {}

  @Process("generate-invoice")
  async handleGenerateInvoice(job: Job<GenerateInvoiceJobData>): Promise<void> {
    const { transactionId, tenantId } = job.data;
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
