import React from 'react';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { InvoicePdfTemplate } from './invoice-pdf-template';

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
    if (!inv) throw new NotFoundException('Invoice not found');

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
            addresses: { orderBy: { isDefault: 'desc' } },
          },
        },
        items: {
          include: { product: { select: { id: true, name: true } } },
        },
        payments: { orderBy: { paidAt: 'asc' } },
      },
    });
    if (!inv) throw new NotFoundException('Invoice not found');

    this.logger.log(`Generating PDF for invoice ${invoiceId}`);

    let pdfBuffer: Buffer;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const element = React.createElement(InvoicePdfTemplate as any, { invoice: inv });
      pdfBuffer = await renderToBuffer(element as any);
    } catch (err) {
      this.logger.error(
        `PDF render failed for invoice ${invoiceId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new Error(`PDF render failed: ${err}`);
    }

    const key = `invoice-pdfs/${invoiceId}.pdf`;
    await this.storage.upload(key, pdfBuffer, 'application/pdf');

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { pdfUrl: key },
    });

    this.logger.log(`Invoice PDF stored at key: ${key}`);
    return this.storage.presignedUrl(key);
  }
}
