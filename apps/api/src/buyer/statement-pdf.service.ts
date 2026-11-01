import React from "react";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { renderToBuffer } from "@react-pdf/renderer";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { StatementService } from "./statement.service";
import { StatementPdfTemplate, StatementTenantInfo } from "./statement-pdf-template";
import { buildAccountStatement } from "../customers/account-statement";
import { AccountStatementPdfTemplate } from "../customers/account-statement-pdf-template";

/**
 * P5-15: renders the monthly statement PDF and returns a presigned download
 * URL (R2-signed GET or local HMAC — downloads WITHOUT a JWT: the "no 401"
 * story). Mirrors InvoicePdfService.generateAndUpload; always renders fresh so
 * the "Generated" stamp + live figures are current; NO DB column to update.
 *
 * SA-1078 (W-1096) PR-3: `generateCurrent` renders the same way for the customer's
 * current "Open balance" statement, under its own key; the monthly route and key are untouched.
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
    const tenant = await this.loadTenant();

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

  /**
   * The current "Open balance" statement as a PDF. Built from the customer-shaped read (`staff: false`), so the page
   * carries no To collect tag. Stored at `statement-pdfs/{customerId}/current.pdf`, overwritten on every call; the
   * signed URL it returns downloads without a JWT, like the monthly one.
   */
  async generateCurrent(customerId: string): Promise<string> {
    const customer = await this.prisma.forTenant().customer.findFirst({
      where: { id: customerId },
      select: { id: true, businessName: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    const statement = await buildAccountStatement(this.prisma, customer, { staff: false });
    const tenant = await this.loadTenant();

    this.logger.log(`Generating current statement PDF for customer ${customerId}`);

    let pdfBuffer: Buffer;
    try {
      const element = React.createElement(AccountStatementPdfTemplate as any, {
        statement,
        tenant,
        generatedAt: new Date(),
      });
      pdfBuffer = await renderToBuffer(element as any);
    } catch (err) {
      this.logger.error(
        `Current statement PDF render failed for customer ${customerId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new Error(`Statement PDF render failed: ${err}`);
    }

    const key = `statement-pdfs/${customerId}/current.pdf`;
    await this.storage.upload(key, pdfBuffer, "application/pdf");
    return this.storage.presignedUrl(key);
  }

  /** The letterhead data for a render: the tenant's config plus its logo as a data URI (a logo that fails to load is skipped). */
  private async loadTenant(): Promise<StatementTenantInfo | null> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return null;
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
    if (!cfg) return null;
    const tenant: StatementTenantInfo = { ...cfg };
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
    return tenant;
  }
}
