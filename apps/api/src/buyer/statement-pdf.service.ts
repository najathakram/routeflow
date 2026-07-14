import React from "react";
import { Injectable, Logger } from "@nestjs/common";
import { renderToBuffer } from "@react-pdf/renderer";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { StatementService } from "./statement.service";
import { StatementPdfTemplate, StatementTenantInfo } from "./statement-pdf-template";

/**
 * P5-15: renders the monthly statement PDF and returns a presigned download
 * URL (R2-signed GET or local HMAC — downloads WITHOUT a JWT: the "no 401"
 * story). Mirrors InvoicePdfService.generateAndUpload; always renders fresh so
 * the "Generated" stamp + live figures are current; NO DB column to update.
 */
@Injectable()
export class StatementPdfService {
  private readonly logger = new Logger(StatementPdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly statementService: StatementService,
  ) {}

  async generateAndUpload(customerId: string, month: string): Promise<string> {
    const statement = await this.statementService.buildMonthlyStatement(customerId, month);

    const tenantId = this.prisma.getTenantId();
    let tenant: StatementTenantInfo | null = null;
    if (tenantId) {
      const cfg = await this.prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          businessName: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          zip: true,
          country: true,
          phone: true,
          website: true,
          customerEmail: true,
          primaryColor: true,
          logoKey: true,
        },
      });
      if (cfg) {
        tenant = { ...cfg };
        if (cfg.logoKey) {
          try {
            const buf = await this.storage.download(cfg.logoKey);
            const lower = cfg.logoKey.toLowerCase();
            const mime =
              lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                ? "image/jpeg"
                : lower.endsWith(".svg")
                  ? "image/svg+xml"
                  : "image/png";
            tenant.logoDataUri = `data:${mime};base64,${buf.toString("base64")}`;
          } catch (err) {
            this.logger.warn(
              `Failed to load tenant logo ${cfg.logoKey}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
    }

    this.logger.log(`Generating statement PDF for customer ${customerId}, month ${month}`);

    let pdfBuffer: Buffer;
    try {
      const element = React.createElement(StatementPdfTemplate as any, {
        statement,
        tenant,
        generatedAt: new Date(),
      });
      pdfBuffer = await renderToBuffer(element as any);
    } catch (err) {
      this.logger.error(
        `Statement PDF render failed for customer ${customerId} month ${month}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new Error(`Statement PDF render failed: ${err}`);
    }

    const key = `statement-pdfs/${customerId}/${month}.pdf`;
    await this.storage.upload(key, pdfBuffer, "application/pdf");
    this.logger.log(`Statement PDF stored at key: ${key}`);
    return this.storage.presignedUrl(key);
  }
}
