import { BadRequestException, ConflictException, Logger, NotFoundException } from "@nestjs/common";
import type { DisplayUnitCatalog } from "./invoice-display-unit";
import { InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { AcceptLineTotal, InvoiceEditBlocked, InvoiceEditConsentBody } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { isAdminInTenant } from "../common/admin-in-tenant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { DISCOUNT_SOURCE_SELECT, discountModeOf } from "../common/discount-tax-mode";
import { assertSalesNotLockedForEdit } from "../regulated/filing-lock";
import * as unitAware from "../orders/unit-aware-guard";
import {
  INVOICE_EDIT_REFUSAL_MESSAGES,
  invoiceEditDecision,
  loadInvoiceEditInputs,
  type InvoiceEditChange,
} from "./invoice-edit-policy";
import { headerKeysChanged, invoiceHeaderData, type EditedLine } from "./invoice-edit-plan";
import { issuedConsent } from "./issued-edit-consent";
import { sumConfirmed } from "./payment-predicates";
import {
  assertTaxStateRecomputable,
  countOrderInvoices,
  guardItemsEditTaxState,
  issuedRecomputeOf,
  orderSiblingCountOf,
  restampEditLines,
  stalePathOf,
  staleTaxStateError,
  taxStateOf,
  tenantPreferredRate,
  type IssuedRecompute,
} from "./stored-tax-state";

/**
 * B1043 (SA-742r2 INV-A): the ONE locked read both branches of `InvoicesService.update()` start from,
 * and the header-only (discount / shippingFee, no `items`) totals rule built on it.
 *
 * Why it exists: the header-only branch read the lines with an unlocked `forTenant()` call, summed a tax
 * that knew neither the regulated levy nor the exempt customer, and wrote the result with a second
 * unlocked call (B1043, B405), so a concurrent line edit could land between the read and the write
 * (B1045). Now both branches lock the Order then the Invoice (the order `deleteInvoice` and every
 * invoice-from-order path take, SA-137/203), then read the invoice, its lines and the customer's
 * exemption inside the same transaction.
 */

export interface LockedInvoiceForEdit {
  /** The invoice row read UNDER the lock (never the unlocked pre-read). */
  invoice: any;
  /** Its tenant-scoped lines, read under the lock. */
  storedRows: any[];
  /** The customer's tax exemption, read in the same transaction. */
  isTaxExempt: boolean;
  /** Its payment rows (amount + status), read under the lock for the B1046 overpayment guard. */
  payments: Array<{ amount: unknown; status: unknown }>;
  /** SA-814e: non-VOID invoices sharing the invoice's order, counted under the same lock (null = no order). */
  orderInvoiceCount?: number | null;
  /** SA-1508: the issued invoice's three-state judge, read under the lock (null for a DRAFT or an order-linked invoice). */
  recompute?: IssuedRecompute | null;
}

/**
 * Locks the Order (when linked) then the Invoice, and returns the invoice, its lines and the customer's
 * exemption, all read inside `tx`. Fails closed:
 *  - 404 when the invoice is gone;
 *  - 409 INVOICE_CHANGED_CONCURRENTLY when its order link moved between the peek and the lock (the order
 *    we locked is not the one it points at);
 *  - 400 when the invoice has a line whose tenant is NULL or another tenant's (B929): the tenant-scoped
 *    line read would silently drop it and under-bill the invoice.
 */
export async function loadLockedInvoiceForEdit(
  tx: any,
  id: string,
  /** H4: the editor's token, checked against the LOCKED row before the lines are read (assertInvoiceCurrent). */
  expectedUpdatedAt?: string,
  onMissingToken?: () => void,
): Promise<LockedInvoiceForEdit> {
  const peek = await tx.invoice.findUnique({ where: { id }, select: { orderId: true } });
  if (!peek) throw new NotFoundException("Invoice not found");
  if (peek.orderId)
    await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${peek.orderId} FOR UPDATE`;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
  // SA-1141 R4/R6: the source's createdAt rides along, so the guard and the totals read the invoice's own discount mode.
  const invoice = await tx.invoice.findUnique({ where: { id }, include: DISCOUNT_SOURCE_SELECT });
  if (!invoice) throw new NotFoundException("Invoice not found");
  if ((invoice.orderId ?? null) !== (peek.orderId ?? null)) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: "The invoice changed while it was being edited. Try again.",
    });
  }
  assertInvoiceCurrent(invoice, expectedUpdatedAt, onMissingToken);
  const storedRows: any[] = await tx.invoiceItem.findMany({ where: { invoiceId: id } });
  const foreign = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM "InvoiceItem"
    WHERE "invoiceId" = ${id} AND "tenantId" IS DISTINCT FROM ${invoice.tenantId ?? null}`;
  if (Number(foreign?.[0]?.n ?? 0) > 0) {
    throw new BadRequestException(
      "This invoice has a line that isn't linked to your business, so it can't be edited safely. Contact support.",
    );
  }
  const customer = await tx.customer.findFirst({
    where: { id: invoice.customerId },
    select: { isTaxExempt: true },
  });
  const payments = await tx.invoicePayment.findMany({
    where: { invoiceId: id },
    select: { amount: true, status: true },
  });
  const orderInvoiceCount = invoice.orderId ? await countOrderInvoices(tx, invoice.orderId) : null;
  const isTaxExempt = !!customer?.isTaxExempt;
  const recompute = await issuedRecomputeOf(tx, invoice, storedRows, isTaxExempt);
  return {
    invoice,
    storedRows,
    isTaxExempt,
    payments: payments ?? [],
    orderInvoiceCount,
    recompute,
  };
}

/**
 * Review hardening: the pre-lock read named an order; the lock was taken on the order the invoice points at NOW.
 * If the link moved in between, the carrier check, ledger resync and order recompute would act on a stale order.
 */
export function assertSameOrderLink(
  locked: { orderId?: string | null },
  pre: { orderId?: string | null },
): void {
  if ((locked.orderId ?? null) !== (pre.orderId ?? null)) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: "The invoice changed while it was being edited. Try again.",
    });
  }
}

/**
 * H4: the editor's `expectedUpdatedAt` must equal the LOCKED invoice's updatedAt, else 409 INVOICE_STALE and
 * nothing is written (a second editor replaying an old form deleted the first editor's changes). Absent = a
 * legacy client: accepted for one release, reported through `onMissing` (a warn log) so it can be made required.
 */
export function assertInvoiceCurrent(
  invoice: { id?: string; updatedAt?: Date | string | null },
  expected: string | null | undefined,
  onMissing?: () => void,
): void {
  if (expected == null) {
    onMissing?.();
    return;
  }
  const current = invoice.updatedAt ? new Date(invoice.updatedAt).getTime() : NaN;
  if (new Date(expected).getTime() !== current) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_STALE,
      message:
        "This invoice was changed by someone else since you opened it. Reload to see the latest, then re-apply your changes.",
    });
  }
}

/** H4: its own channel, so the count of token-less invoice saves is one grep before the token is required. */
const staleTokenLogger = new Logger("InvoiceStaleToken");

export type InvoiceEditClient = "web" | "mobile" | "unknown";

/** The request headers that identify an editing client (all optional; none is trusted for anything but this log). */
export interface InvoiceEditHeaders {
  xClient?: string;
  userAgent?: string;
  appVersion?: string;
}

/**
 * SA-837 row 500: who sent a token-less edit. `x-client` (web | mobile, sent by both apps' one HTTP
 * client) decides first; anything else is ignored. The User-Agent is only the fallback for builds that
 * predate the header (an RN build is okhttp on Android, CFNetwork/Darwin on iOS; the web app is a
 * browser). Mobile also ships as an Expo web export with a browser UA, so only the header is reliable.
 * The app version is the `x-app-version` header, trimmed and capped, else "unknown".
 */
export function classifyInvoiceEditClient(h: InvoiceEditHeaders): {
  client: InvoiceEditClient;
  appVersion: string;
} {
  const ua = h.userAgent ?? "";
  const declared = h.xClient?.trim().toLowerCase();
  const client: InvoiceEditClient =
    declared === "web" || declared === "mobile"
      ? declared
      : /okhttp|CFNetwork|Darwin|Expo|ReactNative/i.test(ua)
        ? "mobile"
        : /Mozilla|Chrome|Safari|Firefox|Edg\//i.test(ua)
          ? "web"
          : "unknown";
  return { client, appVersion: h.appVersion?.trim().slice(0, 32) || "unknown" };
}

/** Step 1 (dark): ONE structured warn per request, no PII, the edit proceeds exactly as before. */
export const noTokenWarner = (
  id: string,
  tenantId: string | null | undefined,
  headers: InvoiceEditHeaders = {},
) => {
  let warned = false;
  return () => {
    if (warned) return;
    warned = true;
    staleTokenLogger.warn({
      event: "INVOICE_EDIT_TOKEN_MISSING",
      route: "PATCH /invoices/:id",
      invoiceId: id,
      tenantId: tenantId ?? null,
      ...classifyInvoiceEditClient(headers),
    });
  };
};

/**
 * H4: the header-only save that touches no totals. Without a token it stays one unlocked update (legacy);
 * with one, the Invoice row is locked and the token checked first, so a stale editor writes nothing.
 */
export async function updateHeaderOnly(
  prisma: { forTenant(): any; tenantTransaction(fn: (tx: any) => Promise<any>): Promise<any> },
  id: string,
  { expectedUpdatedAt }: { expectedUpdatedAt?: string },
  data: any,
  include: any,
  onMissingToken: () => void,
) {
  if (expectedUpdatedAt == null) {
    onMissingToken();
    return prisma.forTenant().invoice.update({ where: { id }, data, include });
  }
  return prisma.tenantTransaction(async (tx: any) => {
    await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.invoice.findUnique({
      where: { id },
      select: { id: true, updatedAt: true, status: true },
    });
    if (!cur) throw new NotFoundException("Invoice not found");
    assertInvoiceCurrent(cur, expectedUpdatedAt);
    assertStillDraft(cur);
    return tx.invoice.update({ where: { id }, data, include });
  });
}

/** r87: the unlocked pre-read said DRAFT; the lock says whether it still is (a send can commit in between). */
export function assertStillDraft(invoice: { status?: unknown }): void {
  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw new BadRequestException("Only DRAFT invoices can be edited");
  }
}

/**
 * SA-1508: how one `update()` save is judged. DRAFT is today's rule, unchanged. ISSUED is an admin's in-place edit of a
 * SENT, VIEWED or OVERDUE invoice: it needs the editor's `expectedUpdatedAt`, is judged by the policy under the lock,
 * and its money gates run only when the save can move money.
 */
export type EditMode = "DRAFT" | "ISSUED";

/** What the gate needs to know about the request, built once per `update()` after its date stamps. */
/** SA-1508 A1-M1: the catalog and base words an issued edit freezes onto its changed and new rows, read BEFORE the transaction. */
export interface IssuedDisplayInputs {
  catalog: DisplayUnitCatalog | null;
  labels: ReadonlyMap<string, string> | null;
}

export interface IssuedEditCtx {
  mode: EditMode;
  actor?: JwtPayload;
  /** The request's tenant (`prisma.getTenantId()`): null for a tenantless super admin, who is never an admin here. */
  tenantId?: string | null;
  dto: Parameters<typeof invoiceHeaderData>[0] & {
    discount?: number | null;
    shippingFee?: number | null;
    acceptLineTotal?: AcceptLineTotal | null;
  };
  issueDate?: Date;
  due: { dueDate: Date | null; depositDueDate: Date | null };
  /** Set by the gate when the admin's echoed figures were accepted (the audit row says so). */
  consented?: boolean;
  /** Read before the transaction by the items branch (A1-M1); absent on a header-only save, which changes no row. */
  display?: IssuedDisplayInputs;
}

/** The 409 of a refused issued edit: `code` INVOICE_EDIT_REFUSED, `reason` for the client's own copy, plain `message`. */
export function invoiceEditRefusal(
  b: InvoiceEditBlocked,
  consent?: InvoiceEditConsentBody | null,
): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.INVOICE_EDIT_REFUSED,
    reason: b.reason,
    message: INVOICE_EDIT_REFUSAL_MESSAGES[b.reason],
    ...(b.orderId ? { orderId: b.orderId, orderNumber: b.orderNumber ?? null } : {}),
    ...(consent ?? {}),
  });
}

/**
 * The mode of this save, decided BEFORE the transaction from the unlocked read, and the cheap refusals with it: an
 * issued invoice is editable here only by an admin of this tenant, in an editable status, with no order behind it.
 * Everything that needs a lock is judged again under it (`assertModeUnderLock`, `assertEditableUnderLock`).
 */
export function editModeOf(
  inv: { status: unknown; orderId?: string | null },
  actor: JwtPayload | undefined,
  tenantId: string | null | undefined,
): EditMode {
  if (inv.status === InvoiceStatus.DRAFT) return "DRAFT";
  const { blocked } = invoiceEditDecision({
    admin: isAdminInTenant(actor, tenantId),
    status: String(inv.status),
    orderId: inv.orderId,
  });
  if (blocked) throw invoiceEditRefusal(blocked);
  return "ISSUED";
}

/**
 * The first judgment under the lock (r87, replacing `assertStillDraft` in both transaction branches): the mode read
 * before the lock must still hold, and an issued save carries the editor's token (no legacy grace: the screens send it).
 */
export function assertModeUnderLock(
  invoice: { status?: unknown },
  mode: EditMode,
  expectedUpdatedAt: string | null | undefined,
): void {
  if (mode === "DRAFT") return assertStillDraft(invoice);
  if (invoice.status === InvoiceStatus.DRAFT) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_CONCURRENTLY,
      message: "The invoice changed while it was being edited. Try again.",
    });
  }
  if (expectedUpdatedAt == null) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_STALE,
      message:
        "Reload this invoice, then save again. A sent invoice can only be changed from its current copy.",
    });
  }
}

/**
 * The one gate of an ISSUED edit under the lock (DRAFT: nothing to judge here). `change` says whether the save can move
 * money; the money gates (filing lock, unit rewrite, payments, credits, a total of zero) are judged only then, so a
 * figure-free save (notes, due date, terms) goes through on an invoice with a payment waiting. The policy decides every
 * refusal, in its own order, so the screen's button and this PATCH never disagree.
 */
export async function assertEditableUnderLock(
  tx: any,
  locked: LockedInvoiceForEdit,
  edit: IssuedEditCtx,
  change: InvoiceEditChange & { newTax?: number; lines?: ReadonlyArray<EditedLine> | null },
): Promise<void> {
  if (edit.mode === "DRAFT") return;
  const { invoice: inv } = locked;
  const admin = isAdminInTenant(edit.actor, edit.tenantId);
  // The loader reads only what a MONEY edit is judged on; an order-linked invoice is refused before it matters.
  const loaded =
    admin && change.money && !inv.orderId
      ? await loadInvoiceEditInputs(
          tx,
          {
            id: inv.id,
            customerId: inv.customerId,
            orderId: inv.orderId,
            items: locked.storedRows,
          },
          { payments: locked.payments },
        )
      : {};
  // A2-N1 rule 6: a money edit of an invoice whose stored figures its lines do not explain needs the admin's consent.
  const consent =
    admin && change.money && !inv.orderId && change.newTotal !== undefined
      ? issuedConsent({
          recompute: locked.recompute,
          invoice: inv,
          storedRows: locked.storedRows,
          written: { total: change.newTotal, tax: change.newTax, lines: change.lines },
          accept: edit.dto.acceptLineTotal,
        })
      : { body: null, consented: false };
  const keys = headerKeysChanged(invoiceHeaderData(edit.dto, edit.due, edit.issueDate), inv);
  const { blocked } = invoiceEditDecision(
    {
      admin,
      status: String(inv.status),
      orderId: inv.orderId,
      ...loaded,
      totalNotFromLines: !!consent.body,
    },
    {
      ...change,
      issueDateChanged: keys.includes("issueDate"),
      depositChanged: keys.includes("depositPercent") || keys.includes("depositDueDate"),
    },
  );
  if (blocked)
    throw invoiceEditRefusal(
      blocked,
      blocked.reason === "TOTAL_NOT_FROM_LINES" ? consent.body : null,
    );
  edit.consented = consent.consented;
  if (!change.money) return;
  await assertSalesNotLockedForEdit(tx, { tenantId: edit.tenantId as string, invoiceId: inv.id });
  await unitAware.assertInvoiceRewriteAllowed(tx, inv);
}

/** The two header money fields rounded to cents at intake (B1047): 10.005 must not store as 10.00 while the total counts 10.01. */
export const intakeMoney = (v: number | null | undefined, stored: unknown): number =>
  v != null ? roundMoney(v) : Number(stored ?? 0);

/** True when two money figures differ by at least a cent (both sides rounded first, L-170). */
const differs = (a: unknown, b: unknown): boolean => roundMoney(Number(a) - Number(b)) !== 0;

/**
 * F1 — the header-only totals: lines unchanged => tax unchanged.
 *
 * Runs `sumInvoiceTotals` (pure: it never mutates the rows) over the locked lines. If its subtotal or tax differs from the
 * invoice's stored subtotal / taxAmount, the stored header cannot be trusted (a legacy draft, a rate
 * the column truncated, an exempt customer with a stale levy): refuse with 409 INVOICE_TAX_STATE_STALE
 * and write nothing. Otherwise the total is recomputed from the stored (== recomputed) subtotal and tax
 * with the new discount and shipping; only `discount`, `shippingFee` and `total` are written.
 *
 * Known edges, ruled by the Lead (INV-A review):
 *  - An EXEMPT customer whose row still carries a levy snapshot (categoryTaxAmount != 0) is stale even when
 *    the stored tax is 0: the items branch would zero the snapshot and resync the regulated ledger, this
 *    branch cannot, so the two must not disagree. Re-saving the lines cleans both (census reason 4).
 *  - B296 (SA-814 §3): create() taxes with the UNROUNDED line rate. Since the sitting-4 widen
 *    (20261020090200_invoice_tax_rate_widen, InvoiceItem.taxRate DECIMAL(9,6)) a fresh draft with a rate such
 *    as 0.08875 keeps it on the line and reproduces its stored tax, so it is NOT stale. Only a legacy row whose
 *    rate was truncated by the old Decimal(5,4) column still fails to reproduce: that is a 409
 *    INVOICE_TAX_STATE_STALE (re-save the lines), never a silent re-tax. Do NOT round the rate in create(): it
 *    would change the money charged.
 */
export function planHeaderOnlyTotals(
  locked: LockedInvoiceForEdit,
  dto: { discount?: number; shippingFee?: number },
  mode: EditMode = "DRAFT",
): { discount: number; shippingFee: number; total: number; subtotal: number; taxAmount?: number } {
  const { invoice, storedRows, isTaxExempt, orderInvoiceCount } = locked;
  const discount = intakeMoney(dto.discount, invoice.discount);
  const shippingFee = intakeMoney(dto.shippingFee, invoice.shippingFee);
  if (mode === "ISSUED" && locked.recompute && locked.recompute.state !== "REPRODUCES") {
    // SA-1508 A2-N1 rule 6: the stored figures are not the lines'. No 409 INVOICE_TAX_STATE_STALE here: the gate asks
    // for consent over these line-based figures (L11: this save cannot stamp), and a confirmed save writes all of them.
    const { totals: t } = taxStateOf({
      invoice,
      storedLines: storedRows,
      canRestamp: false,
      isTaxExempt,
      discount,
      shipping: shippingFee,
    });
    return { discount, shippingFee, total: t.total, subtotal: t.subtotal, taxAmount: t.tax };
  }
  // SA-814 R5-2: the tax half is the ONE recompute guard (stored-tax-state.ts); this path cannot stamp a rate.
  const t = assertTaxStateRecomputable({
    invoice,
    storedLines: storedRows,
    canRestamp: false,
    isTaxExempt,
    refuseExemptLevy: true,
    orderSiblingCount: orderSiblingCountOf({ orderId: invoice.orderId, orderInvoiceCount }),
    discount,
    shipping: shippingFee,
  }).totals;
  if (differs(t.subtotal, invoice.subtotal)) {
    throw staleTaxStateError(stalePathOf(invoice));
  }
  // PRE_TAX: a moved discount moves the tax (it is in the base), so the header carries the re-derived tax with it. LEGACY: the
  // discount never enters the tax, so nothing but discount, fee and total is written (master's shape, byte for byte).
  const taxMoved =
    discountModeOf(invoice) === "PRE_TAX" && differs(t.tax, invoice.taxAmount)
      ? { taxAmount: t.tax }
      : {};
  return { discount, shippingFee, total: t.total, subtotal: t.subtotal, ...taxMoved };
}

/**
 * R-302 M1: the header-only save's write. The plan's subtotal is dropped (master's shape: the lines did not move) EXCEPT on an
 * ISSUED invoice whose stored figures its lines do not explain: its consented save writes the line-derived subtotal with the
 * line-derived total and tax, so the header never keeps a subtotal that disagrees with the total beside it.
 */
export function headerOnlyWrite(
  headerData: Record<string, any>,
  plan: ReturnType<typeof planHeaderOnlyTotals>,
  locked: LockedInvoiceForEdit,
  mode: EditMode,
): Record<string, any> {
  const { subtotal, ...totals } = plan;
  const lineBased =
    mode === "ISSUED" && !!locked.recompute && locked.recompute.state !== "REPRODUCES";
  return { ...headerData, ...totals, ...(lineBased ? { subtotal } : {}) };
}

/**
 * The tax guard of the items save, one call for both modes. DRAFT: SA-814 R5-2's guard, byte for byte. ISSUED
 * (SA-1508 A3-H1): no early return for "the user set a rate" and no refusal here; the verified rate is stamped on the
 * kept rate-0 lines and the consent judge reads the lines this writes (`assertEditableUnderLock`).
 */
export async function guardEditTax(
  tx: any,
  locked: LockedInvoiceForEdit,
  edit: { mode: EditMode },
  args: Omit<Parameters<typeof guardItemsEditTaxState>[0], "locked">,
): Promise<void> {
  if (edit.mode === "ISSUED")
    return restampEditLines(args.editLines, locked.storedRows, locked.recompute?.restampRate);
  const preferredRate = await tenantPreferredRate(tx); // the tenant rate wins the inference when it reproduces the tax
  guardItemsEditTaxState({ ...args, locked: { ...locked, preferredRate } });
}

/**
 * B1046: an edit must not take a DRAFT's total below what is already paid or credited against it
 * (CONFIRMED payments, the basis the status recompute uses). NOT-WORSE (like assertInvoiceTotalsSane): an
 * invoice that is ALREADY overpaid may still be saved while the edit does not deepen the overpayment.
 */
export function assertNotOverpaidByEdit(
  payments: ReadonlyArray<{ amount: unknown; status: unknown }> | null | undefined,
  newTotal: number,
  storedTotal: unknown,
): void {
  const paid = roundMoney(sumConfirmed(payments as any));
  if (paid <= 0) return;
  const over = (total: number) => Math.max(0, roundMoney(paid - roundMoney(total)));
  if (over(newTotal) > over(Number(storedTotal))) {
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_TOTAL_BELOW_PAID,
      message: `This change would take the invoice total ($${roundMoney(newTotal).toFixed(2)}) below the $${roundMoney(paid).toFixed(2)} already paid or credited. Remove the credit first, or change the lines or discount.`,
    });
  }
}
