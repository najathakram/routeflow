import React from "react";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { renderToBuffer } from "@react-pdf/renderer";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { InvoicePdfTemplate } from "./invoice-pdf-template";
import { deriveInvoiceVariant, type InvoicePdfVariant } from "./invoice-pdf-variant";
import { invoiceItemCode } from "./invoice-item-code";
import { roundMoney } from "../common/pricing";

import bwipjs from "bwip-js";

export type { InvoicePdfVariant };

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async getOrGenerate(
    invoiceId: string,
    opts?: { force?: boolean; variant?: InvoicePdfVariant },
  ): Promise<string> {
    // Always render fresh: the DRAFT/FINAL badge + watermark and the
    // "Generated <datetime>" stamp must reflect the current moment and the
    // invoice's live stage, so returning a cached copy would show a stale
    // timestamp (and possibly the wrong stage). `opts.force` is kept for API
    // compatibility; generation is now unconditional.
    return this.generateAndUpload(invoiceId, opts?.variant);
  }

  async generateAndUpload(invoiceId: string, variantArg?: InvoicePdfVariant): Promise<string> {
    const inv = await this.prisma.forTenant().invoice.findUnique({
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
          include: {
            product: { select: { id: true, name: true, barcode: true, sku: true, unitSku: true } },
          },
        },
        // Exclude VOID (bounced) payments (P5-12): the PDF template sums payments
        // into the headline balance-due, so a reversed payment must not appear as
        // received on a customer-facing invoice or under-state what they owe.
        // KNOWN BUG, acknowledged not clean: this not-VOID filter folds unconfirmed
        // DRAFT payments into the customer-facing Balance Due (register B97).
        // Campaign batch F03 replaces it with the CONFIRMED_PAYMENT predicate and
        // REMOVES this suppression with the fix. Do not copy this pattern.
        // scan-ok: draft-payment-not-void — B97 acknowledgment, F03 deletes this line with the fix.
        payments: {
          where: { status: { not: "VOID" } },
          orderBy: { paidAt: "asc" },
          include: { creditNote: { select: { creditNoteNumber: true, reason: true } } },
        },
        order: { select: { status: true } },
      },
    });
    if (!inv) throw new NotFoundException("Invoice not found");

    const variant =
      variantArg ??
      deriveInvoiceVariant(inv as { status: string; order?: { status: string } | null });

    // Load tenant's business info (including logo + primary color) to render
    // a fully branded invoice header.
    const invTenantId = (inv as { tenantId?: string | null }).tenantId ?? null;
    type TenantInfo = {
      businessName: string | null;
      addressLine1: string | null;
      addressLine2: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      country: string | null;
      phone: string | null;
      website: string | null;
      customerEmail: string | null;
      primaryColor: string | null;
      logoKey: string | null;
      logoDataUri?: string;
    };
    let tenantInfo: TenantInfo | null = null;
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
          primaryColor: true,
          logoKey: true,
        },
      });
      if (cfg) {
        tenantInfo = { ...cfg };
        if (cfg.logoKey) {
          try {
            const buf = await this.storage.download(cfg.logoKey);
            // Best-effort mime detection from the key extension; default to png.
            const lower = cfg.logoKey.toLowerCase();
            const mime =
              lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                ? "image/jpeg"
                : lower.endsWith(".svg")
                  ? "image/svg+xml"
                  : "image/png";
            tenantInfo.logoDataUri = `data:${mime};base64,${buf.toString("base64")}`;
          } catch (err) {
            this.logger.warn(
              `Failed to load tenant logo ${cfg.logoKey}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
    }

    this.logger.log(`Generating PDF for invoice ${invoiceId}`);

    // Generate barcodes for each line item
    const itemsWithBarcodes = await Promise.all(
      inv.items.map(async (item) => {
        const barcodeText = invoiceItemCode((item as any).product);
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

    // Deposit schedule (Tier 1): the dollar amount is derived from the CURRENT
    // total, never stored — same convention as invoices.service's
    // computeDepositFields. Null depositPercent means no deposit lines render.
    const depositAmount =
      inv.depositPercent != null
        ? roundMoney((Number(inv.total) * Number(inv.depositPercent)) / 100)
        : null;

    const invWithBarcodes = {
      ...inv,
      items: itemsWithBarcodes,
      tenant: tenantInfo,
      variant,
      generatedAt: new Date(),
      depositAmount,
    };

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
