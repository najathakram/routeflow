import React from "react";
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { renderToBuffer } from "@react-pdf/renderer";
import { PrismaService } from "../prisma/prisma.service";
import { InvoiceTemplate } from "./invoice-template";

// 15-minute presigned URL expiry
const PRESIGNED_EXPIRY_SECONDS = 900;

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const accountId = config.get<string>("r2.accountId") ?? "";
    this.bucket = config.get<string>("r2.bucketName") ?? "routeflow-assets";
    this.s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get<string>("r2.accessKeyId") ?? "",
        secretAccessKey: config.get<string>("r2.secretAccessKey") ?? "",
      },
    });
  }

  // ─── Generate PDF, upload to R2, update Transaction.pdfUrl ────────────────

  async generateInvoicePdf(transactionId: string, tenantId: string): Promise<string> {
    // SECURITY (R7 / REG-B188): scope the lookup to the job's tenantId. The bare
    // findUnique({id}) this replaced would find (and later mutate) ANY tenant's
    // transaction row — a background job carries no ambient request context for
    // forTenant() to key off, so the tenantId travels explicitly in the job payload
    // (GenerateInvoiceJobData) and is checked here instead. Same guard shape as
    // getPresignedUrl's F1-002 fix below.
    //
    // Fail CLOSED on a payload with no tenantId. Job data is deserialized from Redis, so
    // `tenantId: string` on GenerateInvoiceJobData is compile-time only — and Prisma drops
    // `undefined` filter fields, which would silently degrade the two guards below to the
    // tenant-blind `{ id }` shape B188 exists to close. A producer that forgets the field
    // must fail loudly here rather than serve any tenant's transaction.
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new BadRequestException(
        `generate-invoice job for transaction ${transactionId} carries no tenantId`,
      );
    }

    const txn = await this.prisma.transaction.findFirst({
      where: { id: transactionId, tenantId },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        order: true,
        items: {
          include: {
            orderItem: { include: { product: { select: { id: true, name: true } } } },
          },
        },
        payments: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!txn) throw new NotFoundException(`Transaction ${transactionId} not found`);

    this.logger.log(`Generating PDF for transaction ${transactionId}`);

    // Render React PDF to buffer — wrap in try/catch so that a template
    // error surfaces a clear message rather than a generic unhandled rejection.
    let pdfBuffer: Buffer;
    try {
      const element = React.createElement(InvoiceTemplate as any, { transaction: txn });
      pdfBuffer = await renderToBuffer(element as any);
    } catch (err) {
      this.logger.error(
        `PDF render failed for transaction ${transactionId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw new Error(`PDF render failed for transaction ${transactionId}: ${err}`);
    }

    // Upload to Cloudflare R2
    const key = `invoices/${transactionId}.pdf`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: pdfBuffer,
        ContentType: "application/pdf",
        ContentDisposition: `inline; filename="invoice-${transactionId.slice(0, 8)}.pdf"`,
      }),
    );

    this.logger.log(`Uploaded PDF to R2: ${key}`);

    // Persist the R2 object key on the transaction — updateMany carries the same
    // tenantId guard as the read above (R7 / REG-B188).
    await this.prisma.transaction.updateMany({
      where: { id: transactionId, tenantId },
      data: { pdfUrl: key },
    });

    return this.buildPresignedUrl(key);
  }

  // ─── Return a fresh 15-min presigned URL (or null if PDF not yet ready) ───

  async getPresignedUrl(transactionId: string): Promise<string | null> {
    // SECURITY (F1-002): scope the lookup to the caller's tenant. The bare client
    // would mint a presigned URL for ANY tenant's invoice PDF (cross-tenant IDOR).
    // forTenant().findUnique post-filters cross-tenant rows to null; we also select
    // tenantId so the post-filter has the column to compare on.
    const txn = await this.prisma.forTenant().transaction.findUnique({
      where: { id: transactionId },
      select: { pdfUrl: true, tenantId: true },
    });

    if (!txn) throw new NotFoundException("Transaction not found");
    if (!txn.pdfUrl) return null;

    return this.buildPresignedUrl(txn.pdfUrl);
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private async buildPresignedUrl(key: string): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: PRESIGNED_EXPIRY_SECONDS,
    });
  }
}
