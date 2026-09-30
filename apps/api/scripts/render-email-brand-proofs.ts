/**
 * Brand restyle proof (2026-09-17) — renders every transactional email template to a static
 * HTML file under `local-assets/proofs/2026-09-17/email-brand/` for visual review (a
 * Playwright script screenshots each one separately at 600px/375px). Run:
 *   npx ts-node -r tsconfig-paths/register apps/api/scripts/render-email-brand-proofs.ts
 * (from the repo root) or `cd apps/api && npx ts-node -r tsconfig-paths/register
 * scripts/render-email-brand-proofs.ts`.
 *
 * Never sends anything: `send`/`sendPlatform` are replaced on the instance to CAPTURE their
 * `{html, text}` argument instead of touching a real transport, the same technique
 * `email.service.spec.ts` already uses for every other template assertion in this file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EmailService } from "../src/email/email.service";

const OUT_DIR = join(__dirname, "../../../local-assets/proofs/2026-09-17/email-brand");
mkdirSync(OUT_DIR, { recursive: true });

function makeService(): EmailService {
  const config = {
    get: (k: string) =>
      k === "EMAIL_FROM" ? "RouteFlow <invoices@send.routeflow.info>" : undefined,
  } as any;
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: { findMany: async () => [], findFirst: async () => null },
    }),
    tenantConfig: { findFirst: async () => null },
    user: { findFirst: async () => null },
  } as any;
  const encryption = { decrypt: (v: string) => v } as any;
  const mailboxSend = {
    trySend: async () => ({ delivered: false, transport: "mailbox", error: "not_connected" }),
  } as any;
  return new EmailService(config, prisma, encryption, mailboxSend);
}

/** Captures the single {html, text} object a template hands to `send`/`sendPlatform`. */
async function capture(fn: (svc: EmailService) => Promise<unknown>): Promise<{
  html: string;
  text?: string;
}> {
  const svc = makeService();
  let captured: any = null;
  (svc as any).send = async (params: any) => {
    captured = params;
    return { delivered: true, transport: "smtp" };
  };
  (svc as any).sendPlatform = async (params: any) => {
    captured = params;
    return { delivered: true, transport: "smtp" };
  };
  await fn(svc);
  if (!captured) throw new Error("no send/sendPlatform call captured");
  return captured;
}

function writeProof(name: string, html: string) {
  const path = join(OUT_DIR, `${name}.html`);
  writeFileSync(path, html, "utf8");
  console.log(`wrote ${path}`);
}

async function main() {
  writeProof(
    "01-set-password",
    (
      await capture((svc) =>
        svc.sendSetPasswordEmail({
          to: "a@b.com",
          username: "Jordan Rivera",
          setPasswordUrl: "https://app.routeflow.info/reset-password?token=demo123",
          expiryHours: 72,
        }),
      )
    ).html,
  );

  writeProof(
    "02-email-changed-notice",
    (
      await capture((svc) =>
        svc.sendEmailChangedNotice({
          to: "old@example.com",
          username: "Jordan Rivera",
          newEmail: "new@example.com",
        }),
      )
    ).html,
  );

  writeProof(
    "03-email-change-confirmation",
    (
      await capture((svc) =>
        svc.sendEmailChangeConfirmation({ to: "new@example.com", username: "Jordan Rivera" }),
      )
    ).html,
  );

  writeProof(
    "04-role-changed-notice",
    (
      await capture((svc) =>
        svc.sendRoleChangedNotice({
          to: "a@b.com",
          username: "Jordan Rivera",
          oldRole: "DRIVER",
          newRole: "OPERATOR",
          changedBy: "Alex Chen",
        }),
      )
    ).html,
  );

  writeProof(
    "05-merge-verification",
    (
      await capture((svc) =>
        svc.sendMergeVerificationEmail({
          to: "secondary@example.com",
          primaryEmail: "primary@example.com",
          verifyUrl: "https://web.routeflow.info/merge/verify?token=demo",
        }),
      )
    ).html,
  );

  // sendMergeCompleteEmail sends twice (primary + secondary) — capture both.
  {
    const svc = makeService();
    const captured: any[] = [];
    (svc as any).send = async (params: any) => {
      captured.push(params);
      return { delivered: true, transport: "smtp" };
    };
    await svc.sendMergeCompleteEmail({
      primaryEmail: "primary@example.com",
      secondaryEmail: "secondary@example.com",
      primaryName: "Jordan Rivera",
    });
    writeProof("06-merge-complete-primary", captured[0].html);
    writeProof("07-merge-complete-secondary", captured[1].html);
  }

  writeProof(
    "08-invoice",
    (
      await capture((svc) =>
        svc.sendInvoice({
          to: "buyer@example.com",
          customerName: "Acme Buyer",
          invoiceNumber: "INV-4001",
          invoiceId: "inv-4001",
          issueDate: "Sep 1, 2026",
          dueDate: "Oct 1, 2026",
          paymentTermsLabel: "Net 30",
          total: 428.5,
          totalPaid: 128.5,
          balanceDue: 300,
          items: [
            { description: "Case of Widgets (24ct)", qty: 5, unitPrice: 68.5, subtotal: 342.5 },
            {
              description: "Gadget Assembly Kit",
              qty: 2,
              unitPrice: 43.0,
              subtotal: 86.0,
              msrp: 55.0,
            },
          ],
          pdfUrl: "https://app.routeflow.info/invoices/inv-4001.pdf",
        } as any),
      )
    ).html,
  );

  writeProof(
    "09-invoice-reminder",
    (
      await capture((svc) =>
        svc.sendInvoice({
          to: "buyer@example.com",
          customerName: "Acme Buyer",
          invoiceNumber: "INV-4002",
          invoiceId: "inv-4002",
          issueDate: "Aug 1, 2026",
          dueDate: "Aug 31, 2026",
          total: 500,
          balanceDue: 500,
          isReminder: true,
          items: [{ description: "Case of Widgets (24ct)", qty: 10, unitPrice: 50, subtotal: 500 }],
        } as any),
      )
    ).html,
  );

  writeProof(
    "10-low-stock-digest",
    (
      await capture((svc) =>
        svc.sendLowStockDigest({
          to: "admin@acme.example",
          businessName: "Acme Wholesale",
          items: [
            { name: "Acme Widget", sku: "WID-001", currentStock: 3, reorderPoint: 10 },
            { name: "Acme Gadget", sku: null, currentStock: 0, reorderPoint: 5 },
            { name: "Acme Sprocket", sku: "SPR-220", currentStock: 8, reorderPoint: 20 },
          ],
        }),
      )
    ).html,
  );

  console.log(`\nAll proofs written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
