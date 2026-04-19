import React from "react";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { renderToBuffer } from "@react-pdf/renderer";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { InvoicePdfTemplate } from "./invoice-pdf-template";

import bwipjs from "bwip-js";

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async getOrGenerate(invoiceId: string): Promise<string> {
    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, pdfUrl: true },
    });
    if (!inv) throw new NotFoundException("Invoice not found");

    // If pdfUrl already stored, return a fresh presigned URL
    if (inv.pdfUrl) {
      return this.storage.presignedUrl(inv.pdfUrl);
    }

    return this.generateAndUpload(invoiceId);
  }

  async generateAndUpload(invoiceId: string): Promise<string> {
    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: {
          select: {
            id: true,
            businessName: true,
            contactName: true,
            phone: true,
            addresses: { orderBy: { isDefault: "desc" } },
          },
        },
        items: {
          include: { product: { select: { id: true, name: true, barcode: true, sku: true } } },
        },
        payments: { orderBy: { paidAt: "asc" } },
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");

    // Load tenant's business info to render a "Bill From" block on the PDF
    const invTenantId = (inv as any).tenantId as string | null | undefined;
    let tenantInfo: Record<string, any> | null = null;
    if (invTenantId) {
      const cfg = await this.prisma.tenantConfig.findUnique({
        where: { tenantId: invTenantId },
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
        },
      });
      if (cfg) tenantInfo = cfg;
    }

    this.logger.log(`Generating PDF for invoice ${invoiceId}`);

    // Generate barcodes for each line item
    const itemsWithBarcodes = await Promise.all(
      inv.items.map(async (item) => {
        const barcodeText = (item as any).product?.barcode ?? (item as any).product?.sku;
        if (barcodeText) {
          try {
            const buf = await bwipjs.toBuffer({
              bcid: "code128",
              text: String(barcodeText),
              scale: 2,
              height: 8,
              includetext: false,
            });
            return {
              ...item,
              barcodeDataUri: "data:image/png;base64," + Buffer.from(buf).toString("base64"),
              barcodeText: String(barcodeText),
            };
          } catch {
            return item;
          }
        }
        return item;
      }),
    );

    const invWithBarcodes = { ...inv, items: itemsWithBarcodes, tenant: tenantInfo };

    let pdfBuffer: Buffer;
    try {
      const element = React.createElement(InvoicePdfTemplate as any, { invoice: invWithBarcodes });
      pdfBuffer = await renderToBuffer(element as any);
    } catch (err) {
      this.logger.error(
        `PDF render failed for invoice ${invoiceId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new Error(`PDF render failed: ${err}`);
    }

    const key = `invoice-pdfs/${invoiceId}.pdf`;
    await this.storage.upload(key, pdfBuffer, "application/pdf");

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { pdfUrl: key },
    });

    this.logger.log(`Invoice PDF stored at key: ${key}`);
    return this.storage.presignedUrl(key);
  }
}
