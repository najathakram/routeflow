## Status

PLANNED — 2026-07-13

## Context

P5-15 delivers the buyer monthly statement PDF: `GET /buyer/statements/:month` returns `{ url }` (a presigned download URL), plus a web download control on the buyer payments page. Mobile deferred to P10. **NO database migration** — statements are computed on demand from existing `Invoice`/`InvoicePayment`/`CreditNote` rows; the PDF is stored in object storage only (no `pdfUrl`-style column written).

**Orchestrator validation (2026-07-13): the reconciliation arithmetic was hand-checked against both spec fixtures and holds to the cent** — normal month (300 + 250 − 100 − 80 + 0 = 370) and mid-month write-off (300 + 340 − 100 − 80 + (−90 adjustments) = 370). VOID payments excluded, CREDIT_NOTE-method routed to credits not payments. APPROVED.

Verified ground truth at HEAD `37aa18b8` (re-read exact lines before editing):

- **No period/opening-balance code exists.** `CustomersService.getMyStatement` (`customers.service.ts:206-310`) + `getStatementForOperator` (`:582-718`) are all-time SNAPSHOTS. **Both compute `amountPaid` WITHOUT a VOID filter (`:245`,`:639`) — a latent P5-12 bug; P5-15 must NOT copy it: every payment sum filters `status !== "VOID"`.**
- **Net-receivable closing (DECISION):** the analytics "Outstanding" tile is FACE `Σ Invoice.total` (buyer.controller.ts:768-784) — can't equal a reconciling closing. **Closing = NET receivable** = Σ `(total − Σ non-VOID payments)` over invoices `status ∉ {DRAFT,VOID,WRITTEN_OFF}` (the `getStatementForOperator.outstandingAmount` semantics, :642-644, with the VOID filter added + time bounds).
- **Double-count split (critical):** a credit-note application AND an advance application are each an `InvoicePayment` (method CREDIT_NOTE / ADVANCE). Split: **payments bucket = method ∉ {CREDIT_NOTE,ADVANCE}; credits bucket = method ∈ {CREDIT_NOTE,ADVANCE}**. Each row lands in exactly ONE bucket.
- **Download without 401 (REUSE):** `StorageService.presignedUrl(key)` (`storage.service.ts:131-151`) returns an R2-signed GET or a local HMAC `…/uploads/${key}?expires=&sig=` URL — no JWT needed. Web downloads via `fetchPdfBlob(url, buyerApiClient)` (`apps/web/lib/fetch-pdf-blob.ts:42-55`) + programmatic `<a download>`. Shipped example: `handleDownloadPdf` in `buyer/portal/[seller]/invoices/[id]/page.tsx:70-96`. NEVER `<a href>`/`window.open`.
- **Month math (REUSE):** `monthRange(bucket)` at `regulated/period.ts:12-15` — half-open UTC `[from,to)` via `Date.UTC`; `periodBucketOf(date)` (:6-9) is the inverse.
- **PDF stack to MIRROR:** `invoices/invoice-pdf.service.ts` — `generateAndUpload` loads tenantConfig branding (:80-118, logo→data URI + primaryColor), `React.createElement(Template,props)` (:158), `renderToBuffer(element)` (:159, returns Promise<Buffer>), `storage.upload(key,buf,"application/pdf")` (:169), returns `storage.presignedUrl(key)` (:177). Template `invoice-pdf-template.tsx`: Document/Page A4, `buildStyles(primary,navy)`+`darken()`, helpers toNum/fmt/fmtDate/fmtDateTime, "Generated <datetime>" footer. `jsx:"react"` is global in `apps/api/tsconfig.json` so a `.tsx` under `src/buyer/` compiles.
- **Buyer endpoint conventions:** seller-scoped routes stack `@UseGuards(BuyerSellerContextGuard)` + `@UseInterceptors(BuyerTenantInterceptor)` + `@ApiHeader({name:"X-Tenant-Slug",required:true})`, read `ctx.customerId` from `@CurrentBuyerCustomer()` — mirror `@Get("statement")` (:220-227). Interceptor sets tenant ALS so `prisma.forTenant()`, `prisma.getTenantId()` (:24-26), `storage` resolve the seller.
- **Placement:** both new services live in `apps/api/src/buyer/` + register in BuyerModule providers (buyer.module already imports StorageModule; PrismaModule global). No new module, no cycle.
- **Specs:** `createMockPrisma` has customer/invoice/invoicePayment/creditNote proxies + forTenant() — no new wiring. `customers.service.spec.ts:376-467` (P5-13 wallet) must stay green (this plan does NOT touch customers.service). **`buyer.controller.spec.ts` mocks every constructor dep as `useValue` (:97-115) — the two new deps MUST be added there (WP3e) or the suite fails to compile.**

Money guards (bind every WP): every figure via `roundMoney`; every payment sum filters `status !== "VOID"`; payments vs credits split by method (one bucket); `closing` computed INDEPENDENTLY as net receivable at `to`; opening/closing exclude {DRAFT,VOID,WRITTEN_OFF}; charges excludes only {DRAFT,VOID}; the `adjustments` residual absorbs mid-month write-offs so the identity holds to the cent.

Constraints: no migration; Conventional Commits; `npm run verify`.

## Acceptance

1. `GET /buyer/statements/:month` (seller-scoped) → `{ url }`; the PDF downloads with NO Authorization header. Malformed month → 400. Future/empty month → valid zero-activity PDF.
2. The PDF summary satisfies `opening + charges − payments − credits + adjustments = closing` exactly, `closing` = independently computed net receivable at period end; the Adjustments line renders only when non-zero.
3. VOID payments never appear in any figure; a CREDIT_NOTE/ADVANCE application appears once, in Credits.
4. `GET /buyer/statements` → `{ months: [...] }` (≤12 buckets, newest first, back to earliest invoice) powering the web month picker.
5. Web: buyer payments page gains a "Monthly statement" card — month picker + Download button (fetch `{url}` → `fetchPdfBlob` → programmatic `<a download>`; no `<a href>`/`window.open`).
6. Jest: new `statement.service.spec.ts` reconciliation suite green; `customers.service.spec.ts` + `buyer.controller.spec.ts` still compile + pass.

## Work Packages

### WP1 — api: StatementService (the reconciling money core) + spec

files:

- `apps/api/src/buyer/statement.service.ts` (new)
- `apps/api/src/buyer/statement.service.spec.ts` (new)

brief: Pure-Prisma service computing the monthly figures over `monthRange(month)` with an independently computed closing + an `adjustments` residual that makes the identity exact; plus the month-bucket listing.

**1a. `apps/api/src/buyer/statement.service.ts` (new file, FULL exact code):**

```ts
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { monthRange, periodBucketOf } from "../regulated/period";
import { roundMoney } from "../common/pricing";

/** Strict "YYYY-MM" — anything else is a 400 before any query runs. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Payment methods that are credit APPLICATIONS (P5-13), not cash-like tender.
 * A credit-note or advance application is itself an InvoicePayment row, so the
 * month's non-VOID payment rows ALREADY contain them — the statement splits
 * them into the `credits` bucket so nothing is ever double-counted.
 */
const CREDIT_METHODS = ["CREDIT_NOTE", "ADVANCE"] as const;

export interface StatementLineItem {
  date: string;
  type: "INVOICE" | "PAYMENT" | "CREDIT";
  description: string;
  reference: string;
  /** Signed, roundMoney'd: charges positive, payments/credits negative. */
  amount: number;
}

export interface MonthlyStatement {
  period: { month: string; from: string; to: string; label: string };
  customer: { id: string; businessName: string };
  opening: number;
  charges: number;
  payments: number;
  credits: number;
  /** Residual making opening+charges−payments−credits+adjustments=closing EXACT. 0 when |x|<0.005. */
  adjustments: number;
  /** Net receivable at period end — computed INDEPENDENTLY (ground truth). */
  closing: number;
  availableCredit: number;
  lineItems: StatementLineItem[];
}

@Injectable()
export class StatementService {
  constructor(private readonly prisma: PrismaService) {}

  async buildMonthlyStatement(
    customerId: string,
    month: string,
    now: Date = new Date(),
  ): Promise<MonthlyStatement> {
    if (!MONTH_RE.test(month)) {
      throw new BadRequestException("month must be formatted YYYY-MM");
    }
    const { from, to } = monthRange(month);
    const db = this.prisma.forTenant();

    const [customer, invoices, monthPayments, creditNotes] = await Promise.all([
      db.customer.findUnique({
        where: { id: customerId },
        select: { id: true, businessName: true },
      }),
      db.invoice.findMany({
        where: {
          customerId,
          status: { notIn: ["DRAFT", "VOID"] },
          issueDate: { lt: to },
        },
        orderBy: { issueDate: "asc" },
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          status: true,
          issueDate: true,
          payments: { select: { amount: true, paidAt: true, status: true, method: true } },
        },
      }),
      db.invoicePayment.findMany({
        where: {
          invoice: { customerId },
          status: { not: "VOID" },
          paidAt: { gte: from, lt: to },
        },
        orderBy: { paidAt: "asc" },
        select: {
          id: true,
          amount: true,
          method: true,
          reference: true,
          paidAt: true,
          invoice: { select: { invoiceNumber: true } },
        },
      }),
      db.creditNote.findMany({
        where: { customerId },
        select: { amount: true, amountUsed: true, status: true, expiresAt: true },
      }),
    ]);
    if (!customer) throw new NotFoundException("Customer not found");

    // Net receivable at a boundary — getStatementForOperator.outstandingAmount
    // semantics (customers.service.ts:642-644) with the VOID payment filter
    // added and time bounds applied.
    const receivableAt = (boundary: Date): number =>
      roundMoney(
        invoices
          .filter((inv) => inv.status !== "WRITTEN_OFF" && inv.issueDate < boundary)
          .reduce((sum, inv) => {
            const paid = inv.payments
              .filter((p) => p.status !== "VOID" && p.paidAt < boundary)
              .reduce((s, p) => s + Number(p.amount), 0);
            return sum + roundMoney(Number(inv.total) - paid);
          }, 0),
      );

    const opening = receivableAt(from);
    const closing = receivableAt(to);

    const monthInvoices = invoices.filter((inv) => inv.issueDate >= from);
    const charges = roundMoney(monthInvoices.reduce((s, inv) => s + Number(inv.total), 0));

    const isCredit = (method: string) => (CREDIT_METHODS as readonly string[]).includes(method);
    const paymentRows = monthPayments.filter((p) => !isCredit(p.method));
    const creditRows = monthPayments.filter((p) => isCredit(p.method));
    const payments = roundMoney(paymentRows.reduce((s, p) => s + Number(p.amount), 0));
    const credits = roundMoney(creditRows.reduce((s, p) => s + Number(p.amount), 0));

    let adjustments = roundMoney(closing - (opening + charges - payments - credits));
    if (Math.abs(adjustments) < 0.005) adjustments = 0;

    const availableCredit = roundMoney(
      creditNotes
        .filter(
          (c) =>
            c.status !== "VOID" &&
            Number(c.amount) - Number(c.amountUsed) > 0.001 &&
            (!c.expiresAt || new Date(c.expiresAt) > now),
        )
        .reduce((sum, c) => sum + roundMoney(Number(c.amount) - Number(c.amountUsed)), 0),
    );

    const lineItems: StatementLineItem[] = [
      ...monthInvoices.map((inv) => ({
        date: inv.issueDate.toISOString(),
        type: "INVOICE" as const,
        description: `Invoice #${inv.invoiceNumber}${
          inv.status === "WRITTEN_OFF" ? " (written off)" : ""
        }`,
        reference: inv.invoiceNumber,
        amount: roundMoney(Number(inv.total)),
      })),
      ...paymentRows.map((p) => ({
        date: p.paidAt.toISOString(),
        type: "PAYMENT" as const,
        description: `Payment — ${p.method}${p.reference ? ` (${p.reference})` : ""} on #${
          p.invoice.invoiceNumber
        }`,
        reference: p.invoice.invoiceNumber,
        amount: roundMoney(-Number(p.amount)),
      })),
      ...creditRows.map((p) => ({
        date: p.paidAt.toISOString(),
        type: "CREDIT" as const,
        description: `${p.method === "ADVANCE" ? "Advance applied" : "Credit applied"} to #${
          p.invoice.invoiceNumber
        }`,
        reference: p.invoice.invoiceNumber,
        amount: roundMoney(-Number(p.amount)),
      })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const label = from.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    return {
      period: { month, from: from.toISOString(), to: to.toISOString(), label },
      customer: { id: customer.id, businessName: customer.businessName },
      opening,
      charges,
      payments,
      credits,
      adjustments,
      closing,
      availableCredit,
      lineItems,
    };
  }

  /** Month buckets back to the customer's earliest non-DRAFT/VOID invoice, ≤12, newest first. */
  async listAvailableMonths(
    customerId: string,
    now: Date = new Date(),
  ): Promise<{ months: string[] }> {
    const earliest = await this.prisma.forTenant().invoice.findFirst({
      where: { customerId, status: { notIn: ["DRAFT", "VOID"] } },
      orderBy: { issueDate: "asc" },
      select: { issueDate: true },
    });
    if (!earliest) return { months: [] };

    const firstBucket = periodBucketOf(earliest.issueDate);
    const months: string[] = [];
    let y = now.getUTCFullYear();
    let m = now.getUTCMonth() + 1;
    for (let i = 0; i < 12; i++) {
      const bucket = `${y}-${String(m).padStart(2, "0")}`;
      if (bucket < firstBucket) break;
      months.push(bucket);
      m -= 1;
      if (m === 0) {
        m = 12;
        y -= 1;
      }
    }
    return { months };
  }
}
```

**1b. `apps/api/src/buyer/statement.service.spec.ts` (new file):** the reconciliation suite (implement the fixtures exactly): INV_100 (total 500, issued May, payments 200 May CASH / 100 June CHECK / 50 June VOID / 80 June CREDIT_NOTE) + INV_101 (250, issued Jun 15, unpaid); month-payments query returns the non-VOID in-month rows (100 CHECK + 80 CREDIT_NOTE). Assert for 2026-06: opening 300, charges 250, payments 100, credits 80, adjustments 0, closing 370, and `opening+charges−payments−credits+adjustments===closing`; VOID 50 excluded (closing 370 not 320); CREDIT_NOTE in credits not payments; a WRITTEN_OFF INV_200 (90, issued Jun 2) → charges 340, closing 370, adjustments −90, identity holds; DB where-clauses exclude DRAFT/VOID invoices + VOID payments; availableCredit uses remainders (100/40 + VOID 15 → 60); future month empty; malformed months (`2026-13`,`2026-1`,`garbage`,`202606`) → 400; listAvailableMonths walks back to the earliest bucket + empty when none. (Full spec bodies as authored.)

### WP2 — api: StatementPdfService + statement-pdf-template.tsx

files:

- `apps/api/src/buyer/statement-pdf.service.ts` (new)
- `apps/api/src/buyer/statement-pdf-template.tsx` (new)

brief: Mirror `InvoicePdfService.generateAndUpload` (branding load → `React.createElement` → `renderToBuffer` → `storage.upload` → `presignedUrl`), keyed `statement-pdfs/${customerId}/${month}.pdf`, always fresh, NO prisma write.

**2a. `statement-pdf.service.ts` (new file, FULL exact code):**

```ts
import React from "react";
import { Injectable, Logger } from "@nestjs/common";
import { renderToBuffer } from "@react-pdf/renderer";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { StatementService } from "./statement.service";
import { StatementPdfTemplate, StatementTenantInfo } from "./statement-pdf-template";

/**
 * P5-15: renders the monthly statement PDF and returns a presigned download
 * URL (R2-signed GET or local HMAC — downloads WITHOUT a JWT: the "no 401"
 * story). Mirrors InvoicePdfService.generateAndUpload; always renders fresh so
 * the "Generated" stamp + live figures are current; NO DB column to update.
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

    const tenantId = this.prisma.getTenantId();
    let tenant: StatementTenantInfo | null = null;
    if (tenantId) {
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
      if (cfg) {
        tenant = { ...cfg };
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
      }
    }

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
}
```

**2b. `statement-pdf-template.tsx` (new) — detailed brief (mirror `invoice-pdf-template.tsx`):** Imports React + `{Document,Page,Text,View,StyleSheet,Image}` from `@react-pdf/renderer` + `type {MonthlyStatement,StatementLineItem}` from `./statement.service`. Export interface `StatementTenantInfo` = the invoice template's tenant prop shape (businessName/addressLine1/addressLine2/city/state/zip/country/phone/website/customerEmail/primaryColor: string|null + optional `logoDataUri?`). Export `function StatementPdfTemplate({statement, tenant, generatedAt})`. Copy `fmtDate`/`fmtDateTime` verbatim; add `const fmt=(n)=>\`$${Math.abs(n).toFixed(2)}\`` + `const fmtSigned=(n)=>(n<0?\`−$${Math.abs(n).toFixed(2)}\`:\`$${n.toFixed(2)}\`)`. Copy the color constants + `darken()`+ a trimmed`buildStyles(primary,navy)`(page/header/logo*/title/billGrid*/tableHeader*/tableRow*/cell*/totals*/sectionTitle/footer*). Resolve primary/navy as the invoice template does (regex-validate primaryColor). Layout:`<Document title="Statement …"><Page size="A4">`: (1) header — tenant branding block (logo data-URI Image or RF fallback square + address/phone/email/website) + right-aligned "STATEMENT" + `period.label`+ "Statement of Account"; (2) account/period grid — "Statement For" customer.businessName / "Period"`fmtDate(from)`—`fmtDate(to−1ms)`(to is EXCLUSIVE, show last covered day); (3) **summary block** (money-sensitive, fixed order): Opening Balance`fmt(opening)`→`+ Charges fmt(charges)`→`− Payments fmt(payments)`(success) →`− Credits fmt(credits)`(success) → **only when adjustments≠0**:`Adjustments fmtSigned(adjustments)`(gray) → divider → big`Closing Balance fmt(closing)`(danger when >0, success when ≤0); caption "Closing balance is the net amount receivable on open invoices at period end." + (when adjustments≠0) "Adjustments reflect write-offs or corrections during the period."; (4) activity table (sectionTitle "Activity") — Date(flex1)|Description(flex3)|Amount(flex1.2,right); map lineItems with`fmtSigned(amount)`(positive navy, negative success), alt rows; empty → "No activity this period."; (5) available-credit callout (only when`availableCredit>0`): "Available store credit: fmt(availableCredit) — not included in the closing balance."; (6) footer verbatim from the invoice template (tenant · website | Powered by RouteFlow | Generated fmtDateTime(generatedAt)). No watermark/variant/barcodes/Link.

### WP3 — api: buyer endpoints + BuyerModule wiring + controller-spec DI

files:

- `apps/api/src/buyer/buyer.controller.ts` (edit)
- `apps/api/src/buyer/buyer.module.ts` (edit)
- `apps/api/src/buyer/buyer.controller.spec.ts` (edit)

**3a. buyer.controller.ts** — import `StatementService` + `StatementPdfService`; constructor add both params (after `invocePdfService`).
**3c. Endpoints** — insert between `getStatement` and `@Get("payments")`:

```ts
  @Get("statements")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List month buckets available for statement PDFs (P5-15)" })
  getStatementMonths(@CurrentBuyerCustomer() ctx: any) {
    return this.statementService.listAvailableMonths(ctx.customerId);
  }

  @Get("statements/:month")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Generate the monthly statement PDF + return its presigned URL (P5-15)" })
  async getStatementPdf(@Param("month") month: string, @CurrentBuyerCustomer() ctx: any) {
    // The URL is presigned (R2 GET or local HMAC) — browser downloads it WITHOUT
    // a JWT (no 401). Month format validated inside buildMonthlyStatement (400).
    const url = await this.statementPdfService.generateAndUpload(ctx.customerId, month);
    return { url };
  }
```

(No route conflict: `statement`, `statements`, `statements/:month` are distinct literals.)
**3d. buyer.module.ts** — import both services; add `StatementService, StatementPdfService` to providers. No imports change (StorageModule already imported; PrismaModule global). No cycle.
**3e. buyer.controller.spec.ts (MANDATORY)** — import both + add `{ provide: StatementService, useValue: {} }` and `{ provide: StatementPdfService, useValue: {} }` to providers, or the whole suite fails to compile.

### WP4 — web: download-statement control on the buyer payments page + API additions

files:

- `apps/web/lib/api/buyer.ts` (edit)
- `apps/web/app/buyer/portal/[seller]/payments/page.tsx` (edit)

**4a. buyer.ts** — after `useBuyerRemittance`:

```ts
// ─── Monthly statements (P5-15) ───────────────────────────────────────────────
export function useBuyerStatementMonths() {
  return useQuery<{ months: string[] }>({
    queryKey: ["buyer", "statement-months"],
    queryFn: () => buyerApiClient.get("/buyer/statements").then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  });
}

/** Imperative (generation is slow): returns the presigned URL. Callers MUST
 *  download via fetchPdfBlob + programmatic <a download> — never <a href>/window.open. */
export async function fetchStatementPdfUrl(month: string): Promise<string> {
  const r = await buyerApiClient.get<{ url: string }>(`/buyer/statements/${month}`);
  return r.data.url;
}
```

**4b. payments/page.tsx** — add `Download`/`FileText` + `useToast`; import `useBuyerStatementMonths`/`fetchStatementPdfUrl` + `buyerApiClient` + `fetchPdfBlob`. State: `useBuyerStatementMonths()`, `statementMonth` (default to `months[0]` via effect), `statementDownloading`. A module-scope `monthLabel(bucket)` using `Date.UTC(y,m-1,1)` + `toLocaleDateString(...,{timeZone:"UTC"})`. Handler mirrors invoice `handleDownloadPdf` EXACTLY with `const url = await fetchStatementPdfUrl(statementMonth); const blob = await fetchPdfBlob(url, buyerApiClient); a.download = \`statement-${statementMonth}.pdf\`;`(same createObjectURL/click/60s-revoke/toast-on-error,`finally setStatementDownloading(false)`). UI: a "Monthly statement" card (FileText header) between the wallet grid and the payments table — a native `<select>`of`months`(options`monthLabel(m)`) + a Download button (Loader2 while downloading, disabled when no month/downloading); when `months.length===0` show "Statements become available after your first invoice."

### WP5 — code-map + verify

files: `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/_meta.json`
brief: api.md → buyer: `StatementService.buildMonthlyStatement` (monthRange UTC; opening/closing = independent net receivables, VOID-filtered; payments vs credits split by CREDIT_NOTE/ADVANCE; adjustments residual makes the identity exact; listAvailableMonths ≤12) + `StatementPdfService.generateAndUpload` → `statement-pdfs/${customerId}/${month}.pdf` → presignedUrl (no-JWT download; no DB write) + `GET /buyer/statements[/:month]`. web.md → payments "Monthly statement" card (useBuyerStatementMonths + fetchStatementPdfUrl + fetchPdfBlob + programmatic download). Bump \_meta generatedAt + prepend a P5-15 note. `npm run verify`.

### Assumptions to double-check

1. Signatures at HEAD: `renderToBuffer(el):Promise<Buffer>`, `storage.upload(key,buf,ct):Promise<string>` (:97), `storage.presignedUrl(key):Promise<string>` (:131), `monthRange("YYYY-MM"):{from,to}` UTC half-open, `prisma.getTenantId():string|null` (:24). Also `prisma.tenantConfig.findUnique` with those branding fields + `storage.download(key)` — both used by invoice-pdf.service (confirm field names).
2. `jsx:"react"` global in apps/api/tsconfig.json → `statement-pdf-template.tsx` compiles under src/buyer/.
3. **buyer.controller.spec.ts DI (WP3e) is mandatory.**
4. `buyerApiClient` auto-attaches Bearer + X-Tenant-Slug; `fetchPdfBlob` picks auth'd vs bare by origin — don't re-implement.
5. Statement PDFs re-render every request (fresh stamp); object overwritten. NO migration.
6. The month-payments query has no invoice-status filter (only customerId + non-VOID + in-month); any activity on excluded invoices is absorbed by `adjustments` — identity guaranteed by construction.
7. The no-VOID-filter bug in getMyStatement/getStatementForOperator is deliberately NOT fixed here; do not copy it.

### Critical Files

- apps/api/src/buyer/statement.service.ts (new — money core)
- apps/api/src/buyer/buyer.controller.ts
- apps/api/src/invoices/invoice-pdf.service.ts (mirror source for WP2)
- apps/api/src/buyer/buyer.module.ts
- apps/web/app/buyer/portal/[seller]/payments/page.tsx
