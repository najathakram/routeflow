import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import type { StorageService } from "../storage/storage.service";
import { compressDocument } from "../storage/compress.util";

/**
 * Receipt/slip/check photos attached to a payment EVENT — moved verbatim out of
 * `invoices.service.ts` (size ratchet, SA-065). `InvoicesService` keeps the three public methods
 * as one-line delegates, so its controller and specs are unchanged.
 */
export interface PaymentImageDeps {
  prisma: PrismaService;
  storage: StorageService;
}

async function findPaymentOrThrow(deps: PaymentImageDeps, paymentId: string) {
  const payment = await deps.prisma
    .forTenant()
    .invoicePayment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new NotFoundException("Payment not found");
  return payment;
}

/**
 * Attach a receipt/slip/check photo to a payment EVENT. Uses `compressDocument`
 * (NOT `compressImage`) — like the expense-receipt endpoint, this route has no
 * controller MIME allowlist and mobile file pickers routinely send
 * `application/octet-stream`/empty content-type; `compressDocument` byte-sniffs
 * via sharp (any real image → JPEG) and tolerates a PDF, so a real receipt/check
 * photo never 500s on a generic content-type.
 */
export async function uploadPaymentImage(
  deps: PaymentImageDeps,
  paymentId: string,
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<{ url: string }> {
  const payment = await findPaymentOrThrow(deps, paymentId);
  let compressed;
  try {
    compressed = await compressDocument(buffer, mimeType);
  } catch {
    throw new BadRequestException("File is not a decodable image or PDF");
  }
  // One object per payment EVENT: a grouped standalone payment (several rows
  // sharing paymentGroupId) anchors on the group id so the same photo is
  // reachable from every allocation row.
  const anchor = payment.paymentGroupId ?? payment.id;
  const key = `payments/${anchor}/image.${compressed.ext}`;
  await deps.storage.upload(key, compressed.buffer, compressed.mimeType);
  const data = {
    imageKey: key,
    imageOriginalName: originalName,
    imageMimeType: compressed.mimeType,
  };
  if (payment.paymentGroupId) {
    await deps.prisma
      .forTenant()
      .invoicePayment.updateMany({ where: { paymentGroupId: payment.paymentGroupId }, data });
  } else {
    await deps.prisma.forTenant().invoicePayment.update({ where: { id: paymentId }, data });
  }
  return { url: await deps.storage.presignedUrl(key) };
}

export async function getPaymentImageUrl(
  deps: PaymentImageDeps,
  paymentId: string,
): Promise<{ url: string }> {
  const payment = await findPaymentOrThrow(deps, paymentId);
  if (!payment.imageKey) throw new NotFoundException("No image attached to this payment");
  return { url: await deps.storage.presignedUrl(payment.imageKey) };
}

export async function deletePaymentImage(
  deps: PaymentImageDeps,
  paymentId: string,
): Promise<{ success: boolean }> {
  const payment = await findPaymentOrThrow(deps, paymentId);
  if (!payment.imageKey) throw new NotFoundException("No image to delete");
  const clear = { imageKey: null, imageOriginalName: null, imageMimeType: null };
  if (payment.paymentGroupId) {
    await deps.prisma.forTenant().invoicePayment.updateMany({
      where: { paymentGroupId: payment.paymentGroupId },
      data: clear,
    });
  } else {
    await deps.prisma.forTenant().invoicePayment.update({ where: { id: paymentId }, data: clear });
  }
  await deps.storage.delete(payment.imageKey);
  return { success: true };
}
