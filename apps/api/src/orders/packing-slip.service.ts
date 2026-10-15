/**
 * Packing slips (#3168): ONE pdf, a page per carrier order, through the same render/upload/signed-URL
 * pipeline as the invoice PDF (invoice-pdf.service.ts). Orders are read through `prisma.forTenant()`, so
 * a foreign id is "not found" like a missing one. Non-carrier and cancelled orders are skipped with an
 * outcome; nothing is stored when no order is includable.
 */
import { randomUUID } from "crypto";
import React from "react";
import { Injectable, Logger } from "@nestjs/common";
import { renderToBuffer } from "@react-pdf/renderer";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import type { BatchShipOutcome } from "./order-batch-ship";
import {
  buildPackingSlipPages,
  classifyForSlip,
  PACKING_SLIP_LINE_SELECT,
  type PackingSlipOrderLike,
  type PackingSlipSeller,
} from "./packing-slip-data";
import { PackingSlipPdfTemplate } from "./packing-slip-pdf-template";

export interface PackingSlipsOut {
  url: string | null;
  included: string[];
  skipped: { orderId: string; outcome: BatchShipOutcome }[];
}

@Injectable()
export class PackingSlipService {
  private readonly logger = new Logger(PackingSlipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async generate(orderIds: string[]): Promise<PackingSlipsOut> {
    const ids = [...new Set(orderIds)];
    const rows = (
      await this.prisma.forTenant().order.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          fulfillPath: true,
          shippingCarrier: true,
          shippingTrackingNumber: true,
          customer: {
            select: {
              businessName: true,
              contactName: true,
              addresses: {
                select: {
                  line1: true,
                  line2: true,
                  city: true,
                  state: true,
                  zip: true,
                  isDefault: true,
                  addressType: true,
                },
                orderBy: { isDefault: "desc" },
              },
            },
          },
          lineItems: {
            orderBy: { createdAt: "asc" },
            select: PACKING_SLIP_LINE_SELECT,
          },
        },
      })
    ).map(({ lineItems, ...o }) => ({
      ...o,
      items: lineItems,
    })) as unknown as PackingSlipOrderLike[];

    const byId = new Map(rows.map((r) => [r.id, r]));
    const include: PackingSlipOrderLike[] = [];
    const skipped: PackingSlipsOut["skipped"] = [];
    for (const id of ids) {
      const o = byId.get(id);
      if (!o) {
        skipped.push({ orderId: id, outcome: "NOT_FOUND" });
        continue;
      }
      const why = classifyForSlip(o);
      if (why) skipped.push({ orderId: id, outcome: why });
      else include.push(o);
    }
    if (include.length === 0) return { url: null, included: [], skipped };

    const tenantId = this.prisma.getTenantId();
    const cfg = tenantId
      ? ((await this.prisma.tenantConfig.findUnique({
          where: { tenantId },
          select: {
            businessName: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            state: true,
            zip: true,
            phone: true,
          },
        })) as PackingSlipSeller | null)
      : null;

    const pages = buildPackingSlipPages(include, cfg ?? {});
    let pdf: Buffer;
    try {
      pdf = await renderToBuffer(
        React.createElement(PackingSlipPdfTemplate as any, { pages }) as any,
      );
    } catch (err) {
      this.logger.error(`Packing slip render failed: ${err instanceof Error ? err.stack : err}`);
      throw new Error("Packing slip render failed");
    }
    // The key embeds the tenant id (uploads.controller enforces it on read): never write one without it.
    if (!tenantId) throw new Error("Packing slip storage requires a tenant id");
    const key = `packing-slips/${tenantId}/${randomUUID()}.pdf`;
    await this.storage.upload(key, pdf, "application/pdf");
    return {
      url: await this.storage.presignedUrl(key),
      included: include.map((o) => o.id),
      skipped,
    };
  }
}
