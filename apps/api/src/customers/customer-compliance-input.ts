import { ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

// Compliance-only fields the CSV importer (B858/B859, FIX3) can write through
// `CustomersService.update`'s `options.compliance` param. Deliberately NOT part of
// `UpdateCustomerDto`/`CreateCustomerDto` (L-181) — the controller never passes `options`, so no
// HTTP surface can reach these fields regardless of DTO whitelist config.
//
// SMS/WhatsApp consent is deliberately NOT here (SA-305 (2)): consent is written only by
// `CustomersService.setCustomerConsent`, which records its evidence row in the same transaction.
export interface CustomerComplianceInput {
  tobaccoLicenseNo?: string | null;
  tobaccoLicenseExpiry?: Date | null;
}

export interface CustomerUpdateOptions {
  compliance?: CustomerComplianceInput;
}

/** The `data` slice `CustomersService.update` spreads for the defined compliance keys. */
export function complianceData(c?: CustomerComplianceInput): Prisma.CustomerUpdateInput {
  return {
    ...(c?.tobaccoLicenseNo !== undefined && { tobaccoLicenseNo: c.tobaccoLicenseNo }),
    ...(c?.tobaccoLicenseExpiry !== undefined && { tobaccoLicenseExpiry: c.tobaccoLicenseExpiry }),
  };
}

/** `data` with the defined compliance keys merged in — never consent (see setCustomerConsent). */
export function withCompliance<T extends object>(
  options: CustomerUpdateOptions | undefined,
  data: T,
) {
  return { ...data, ...complianceData(options?.compliance) } as T;
}

export interface ConsentChange {
  smsConsent?: boolean;
  waConsent?: boolean;
}

export interface ConsentEvidence {
  userId: string;
  source: string;
  fileName?: string;
  row?: number;
}

export type ConsentArgs = [customerId: string, consent: ConsentChange, evidence: ConsentEvidence];

/**
 * SA-305 (2): the body of `CustomersService.setCustomerConsent`, the ONLY writer of SMS/WhatsApp
 * consent (it lives here so customers.service.ts holds its size ratchet). Self-opening: one
 * tenantTransaction updates the consent column(s) AND inserts one evidence row per channel via
 * `tx.auditLog.create` (never `AuditService.log`, which swallows errors), so a failing evidence
 * insert rolls the flag back and a failing flag update leaves no evidence row. It must never be
 * called from inside another open tenantTransaction (pinned: consent-caller-no-nesting.spec.ts).
 */
export async function writeConsentWithEvidence(
  prisma: PrismaService,
  customerId: string,
  consent: ConsentChange,
  evidence: ConsentEvidence,
): Promise<void> {
  if (consent.smsConsent === undefined && consent.waConsent === undefined) return;
  await prisma.tenantTransaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.customer.findFirst({ where: { id: customerId } });
    if (!existing || existing.deletedAt) {
      throw new ConflictException("Restore the customer first");
    }

    const now = new Date();
    await tx.customer.update({
      where: { id: customerId },
      data: {
        ...(consent.smsConsent !== undefined && { smsConsent: consent.smsConsent }),
        ...(consent.waConsent !== undefined && { waConsent: consent.waConsent }),
        consentUpdatedAt: now,
      },
    });

    const channels: { field: keyof ConsentChange; channel: "sms" | "wa" }[] = [
      { field: "smsConsent", channel: "sms" },
      { field: "waConsent", channel: "wa" },
    ];
    for (const { field, channel } of channels) {
      const value = consent[field];
      if (value === undefined) continue;
      await tx.auditLog.create({
        data: {
          tenantId: prisma.getTenantId(),
          userId: evidence.userId,
          action: `customer.consent.${evidence.source}`,
          entityType: "Customer",
          entityId: customerId,
          meta: {
            source: evidence.source,
            userId: evidence.userId,
            fileName: evidence.fileName ?? null,
            row: evidence.row ?? null,
            channel,
            value,
            timestamp: now.toISOString(),
          },
        },
      });
    }
  });
}
