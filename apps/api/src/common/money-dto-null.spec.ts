import "reflect-metadata";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { plainToInstance } from "class-transformer";
import { getMetadataStorage, IsNumber, validate } from "class-validator";

import { AppliedCreditNoteDto, CreateOrderDto, OrderItemDto } from "../orders/dto/create-order.dto";
import { CreateSaleDto } from "../orders/dto/create-sale.dto";
import { UpdateOrderItemsDto } from "../orders/dto/update-order-items.dto";
import { CounterSaleItemDto, CounterSalePaymentDto } from "../orders/counter-sale/counter-sale.dto";
import {
  CreateInvoiceDto,
  CreateInvoiceItemDto,
  RecordInvoicePaymentDto,
} from "../invoices/dto/create-invoice.dto";
import { UpdateInvoiceDto } from "../invoices/dto/update-invoice.dto";
import { UpdatePromotionDto } from "../promotions/dto/update-promotion.dto";
import { CreateEstimateItemDto } from "../estimates/dto/create-estimate.dto";
import { ApplyCreditNoteDto } from "../credit-notes/dto/apply-credit-note.dto";
import { CreateRecurringInvoiceDto } from "../recurring-invoices/dto/create-recurring-invoice.dto";
import { UpdateRecurringInvoiceDto } from "../recurring-invoices/dto/update-recurring-invoice.dto";
import { CreateVendorBillDto, VendorBillItemDto } from "../vendor-bills/dto/create-vendor-bill.dto";
import { UpdateVendorBillDto } from "../vendor-bills/dto/update-vendor-bill.dto";
import { ApproveInlineReturnDto } from "../returns/dto/approve-inline-return.dto";
import { CaptureInlineReturnItemDto } from "../returns/dto/capture-inline-return.dto";
import { UpdateExpenseDto } from "../bookkeeping/dto/create-expense.dto";
import { ApplyAdvancePaymentDto } from "../customers/dto/advance-payment.dto";
import { UpdateCustomerDto } from "../customers/dto/update-customer.dto";
import { PurchaseOrderItemDto } from "../inventory/dto/create-purchase-order.dto";
import { VariantAssignmentDto } from "../inventory/dto/variant-assign.dto";
import { CompleteSetupDto } from "../import/dto/resolution.dto";
import { CreateProductDto } from "../products/dto/create-product.dto";
import { CreateSalesAgentDto } from "../sales-agents/sales-agents.controller";
import { CreateTrackedCategoryDto } from "../tracked-categories/dto/create-tracked-category.dto";
import { IsOptionalNotNull } from "./validators/optional-not-null";

/**
 * Row 602 (class fix for row 591): `@IsOptional()` skips EVERY validator for JSON `null`, so an optional
 * money field declared `@IsOptional() @IsNumber()` lets `{ "unitPrice": null }` reach a service whose
 * `x !== undefined ? Number(x) : …` makes it `Number(null) === 0` — a silent $0 price / discount / fee / tax.
 * Optional money fields use `@IsOptionalNotNull()` (omitted = fine, null = 400). This spec pins that for EVERY
 * numeric money-named property of every request DTO, and keeps the escape hatch explicit and reasoned.
 */

/** A property whose name matches this AND carries a numeric validator is a money field. */
export const MONEY_PROPERTY_NAME =
  /(price|cost|amount|discount|fee|tax|deposit|total|charge|msrp|rate|credit|balance|levy|commission)/i;

/** class-validator constraint names that make a property numeric. */
export const NUMERIC_VALIDATOR_NAMES: readonly string[] = [
  "isNumber",
  "isInt",
  "isDecimal",
  "isPositive",
  "isNumberString",
  "min",
  "max",
];

/**
 * Optional money fields that KEEP `@IsOptional()` (null passes validation) — each with the reason null is
 * legitimate there. A field a client sends null for must NOT be switched without a client change, so it is
 * listed here instead. A stale entry (field switched, renamed or removed) fails the "allow-list is live" test.
 */
export const NULL_ALLOWED_MONEY_FIELDS: Readonly<Record<string, string>> = {
  // ── null is the deliberate "clear" ──────────────────────────────────────────────────────────────────
  "CreateInvoiceDto.depositPercent":
    "the shared source of the PATCH field: PATCH /invoices/:id writes dto.depositPercent when !== undefined, so null clears the deposit; create treats null as no deposit (`?? null`)",
  "UpdateInvoiceDto.depositPercent": "inherited via PartialType: null clears the deposit schedule",
  "UpdateInvoiceSettingsDto.depositDefaultPercent":
    "web settings sends null to clear the tenant default deposit (apps/web/lib/api/invoices.ts, settings page) — switch only with a client change",
  "UpdateCustomerDto.creditLimit": "null clears the customer's credit limit",
  "UpdateCustomerDto.defaultDepositPercent":
    "null clears the customer's default deposit (explicit ValidateIf)",
  "UpsertCustomerPriceDto.msrp": "null = an override row with no MSRP (web sends msrp: null)",
  "BulkSetMsrpItemDto.msrp": "null clears the product MSRP",
  "UpsertStockCountLineDto.unitCostOverride":
    "null clears the per-line cost override (web StockCountTab sends null)",
  "CreateProductUnitDto.price": "null = no price at this unit level (tier ladder is nullable)",
  "CreateProductUnitDto.priceTier2": "null clears a tier price",
  "CreateProductUnitDto.priceTier3": "null clears a tier price",
  "CreateProductUnitDto.priceTier4": "null clears a tier price",
  "CreateProductUnitDto.priceTier5": "null clears a tier price",
  "UpdateProductUnitDto.price": "null clears the unit price",
  "UpdateProductUnitDto.priceTier2": "null clears a tier price",
  "UpdateProductUnitDto.priceTier3": "null clears a tier price",
  "UpdateProductUnitDto.priceTier4": "null clears a tier price",
  "UpdateProductUnitDto.priceTier5": "null clears a tier price",
  "UpdatePlanDefinitionDto.monthlyPrice": "null = custom (Enterprise) price (explicit ValidateIf)",
  "UpdatePlanDefinitionDto.annualPrice": "null = auto-fill from monthly (explicit ValidateIf)",
  // ── null is already "absent"/"no override", never $0 ───────────────────────────────────────────────
  "CreateOrderDto.commissionRatePct":
    "parseCommissionRatePct maps null to null = no per-order override (not 0)",
  "CreateSaleDto.commissionRatePct": "parseCommissionRatePct maps null to null = no override",
  "ImportProductItemDto.averageCost":
    "ProductsService.importProducts gates on `averageCost != null`: null = no opening cost",
  // product decimal strings: @Transform(toOptionalDecimalString) maps null / "" to undefined BEFORE validation
  "CreateProductDto.standardCost": "toOptionalDecimalString turns null into undefined (absent)",
  "CreateProductDto.priceTier2": "toOptionalDecimalString turns null into undefined (absent)",
  "CreateProductDto.priceTier3": "toOptionalDecimalString turns null into undefined (absent)",
  "CreateProductDto.priceTier4": "toOptionalDecimalString turns null into undefined (absent)",
  "CreateProductDto.priceTier5": "toOptionalDecimalString turns null into undefined (absent)",
  "UpdateProductDto.pricePerUnit": "toOptionalDecimalString turns null into undefined (absent)",
  "UpdateProductDto.standardCost": "toOptionalDecimalString turns null into undefined (absent)",
  "UpdateProductDto.priceTier2": "toOptionalDecimalString turns null into undefined (absent)",
  "UpdateProductDto.priceTier3": "toOptionalDecimalString turns null into undefined (absent)",
  "UpdateProductDto.priceTier4": "toOptionalDecimalString turns null into undefined (absent)",
  "UpdateProductDto.priceTier5": "toOptionalDecimalString turns null into undefined (absent)",
  "CreateProductDto.msrp":
    'toOptionalMsrp: null / "" = explicit clear (display-only, not money math)',
  "UpdateProductDto.msrp":
    'toOptionalMsrp: null / "" = explicit clear (display-only, not money math)',
};

// ─── discovery ───────────────────────────────────────────────────────────────────────────────────────

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ALL_SOURCE = walk(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"));
/** Request DTOs live in `*.dto.ts`; these non-`.dto.ts` modules declare money DTOs inline (a controller). */
export const INLINE_DTO_MODULES: readonly string[] = ["sales-agents/sales-agents.controller.ts"];

const DTO_FILES = ALL_SOURCE.filter(
  (f) => f.endsWith(".dto.ts") || INLINE_DTO_MODULES.includes(relative(SRC, f)),
);

/** `@nestjs/mapped-types` shell classes: their source classes are scanned directly, and a subclass resolves them. */
const MAPPED_TYPE_PREFIX = /^(Partial|Omit|Pick|Intersection)(.+)$/;

/** mapped-types names a shell `Partial<Source>` / `Omit<Source>`…, where Source is a class or another shell (`…ClassType`). */
function isMappedTypeShell(name: string, known: ReadonlySet<string>): boolean {
  const m = MAPPED_TYPE_PREFIX.exec(name);
  if (!m) return false;
  return m[2] === "ClassType" || known.has(m[2]) || isMappedTypeShell(m[2], known);
}

/**
 * Money fields whose name is too generic for MONEY_PROPERTY_NAME (a bare `value` matches too much elsewhere).
 * Scoped to one class each.
 */
export const SCOPED_MONEY_FIELDS: ReadonlySet<string> = new Set([
  "CreatePromotionDto.value",
  "UpdatePromotionDto.value",
]);

/** The class-validator metadata-storage target type (a constructor). */
type DtoTarget = Parameters<
  ReturnType<typeof getMetadataStorage>["getTargetValidationMetadatas"]
>[0];
type MetaLike = { name?: string; type: string; propertyName: string };

/** Every named class class-validator knows about, after loading every DTO module. */
function loadDtoClasses(): DtoTarget[] {
  for (const f of DTO_FILES) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(f);
  }
  const storage = getMetadataStorage() as unknown as {
    validationMetadatas: Map<DtoTarget, unknown>;
  };
  const named = [...storage.validationMetadatas.keys()].filter(
    (c) => typeof c === "function" && c.name,
  );
  const known = new Set(named.map((c) => c.name));
  return named.filter((c) => !isMappedTypeShell(c.name, known));
}

function resolvedMetadata(cls: DtoTarget): MetaLike[] {
  return getMetadataStorage().getTargetValidationMetadatas(
    cls,
    undefined as unknown as string,
    true,
    false,
  ) as unknown as MetaLike[];
}

/** `Class.prop` for every money property (numeric validator + money-ish name) that still skips null. */
function optionalMoneyFields(): Set<string> {
  const found = new Set<string>();
  for (const cls of loadDtoClasses()) {
    const byProp = new Map<string, MetaLike[]>();
    for (const m of resolvedMetadata(cls)) {
      if (!byProp.has(m.propertyName)) byProp.set(m.propertyName, []);
      byProp.get(m.propertyName)!.push(m);
    }
    for (const [prop, metas] of byProp) {
      if (!MONEY_PROPERTY_NAME.test(prop) && !SCOPED_MONEY_FIELDS.has(`${cls.name}.${prop}`))
        continue;
      if (!metas.some((m) => m.name && NUMERIC_VALIDATOR_NAMES.includes(m.name))) continue;
      if (!metas.some((m) => m.name === "isOptional")) continue; // IsOptionalNotNull has no such name
      found.add(`${cls.name}.${prop}`);
    }
  }
  return found;
}

// ─── the pin ─────────────────────────────────────────────────────────────────────────────────────────

describe("money DTO null rejection (row 602)", () => {
  const optionalMoney = optionalMoneyFields();

  it("loads a plausible number of DTO classes (discovery is not silently empty)", () => {
    expect(DTO_FILES.length).toBeGreaterThan(100);
    expect(loadDtoClasses().length).toBeGreaterThan(300);
  });

  it("no money-named numeric property is optional-without-null-rejection unless allow-listed", () => {
    const offenders = [...optionalMoney].filter((k) => !(k in NULL_ALLOWED_MONEY_FIELDS)).sort();
    // Use @IsOptionalNotNull() (common/validators/optional-not-null.ts), or — when null is a deliberate clear —
    // add the field to NULL_ALLOWED_MONEY_FIELDS with the reason, after checking the web/mobile builders.
    expect(offenders).toEqual([]);
  });

  it("the allow-list is live: every entry still names a field that skips null", () => {
    const stale = Object.keys(NULL_ALLOWED_MONEY_FIELDS)
      .filter((k) => !optionalMoney.has(k))
      .sort();
    expect(stale).toEqual([]);
  });

  it("every allow-list entry carries a reason", () => {
    for (const [k, reason] of Object.entries(NULL_ALLOWED_MONEY_FIELDS)) {
      expect({ k, ok: reason.trim().length > 10 }).toEqual({ k, ok: true });
    }
  });

  it("no inline (non-.dto.ts) module declares an @IsOptional() money field outside INLINE_DTO_MODULES", () => {
    const offenders: string[] = [];
    for (const f of ALL_SOURCE) {
      const rel = relative(SRC, f);
      if (f.endsWith(".dto.ts") || INLINE_DTO_MODULES.includes(rel)) continue;
      const text = readFileSync(f, "utf8");
      if (!text.includes('from "class-validator"')) continue;
      // One property declaration ends at `;` — decorators may span several lines.
      for (const chunk of text.split(";")) {
        const decl = /(\w+)\??\s*:\s*(?:number|string)\s*$/.exec(chunk.trimEnd());
        if (!decl || !MONEY_PROPERTY_NAME.test(decl[1])) continue;
        if (/@IsOptional\(\)/.test(chunk) && /@(IsNumber|IsInt|IsDecimal)\b/.test(chunk)) {
          offenders.push(`${rel}: ${decl[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ─── behaviour ───────────────────────────────────────────────────────────────────────────────────────

async function messagesFor(
  Dto: new () => object,
  body: Record<string, unknown>,
  prop: string,
): Promise<string[]> {
  const errors = await validate(plainToInstance(Dto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors
    .filter((e) => e.property === prop)
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

/** [label, DTO, property, a valid value for it]. One representative field of each DTO family, plus every PartialType Update*. */
const REFUSES_NULL: ReadonlyArray<[string, new () => object, string, number]> = [
  ["orders: line unitPrice", OrderItemDto, "unitPrice", 0],
  ["orders: shippingFee", CreateOrderDto, "shippingFee", 0],
  ["orders: discountAmount", CreateOrderDto, "discountAmount", 0],
  ["orders: applied credit amount", AppliedCreditNoteDto, "amount", 1],
  ["orders: create-sale shippingFee", CreateSaleDto, "shippingFee", 0],
  ["orders: edit-items shippingFee", UpdateOrderItemsDto, "shippingFee", 0],
  ["counter-sale: line unitPrice", CounterSaleItemDto, "unitPrice", 0],
  ["counter-sale: payment amount", CounterSalePaymentDto, "amount", 0],
  ["invoices: line discount", CreateInvoiceItemDto, "discount", 0],
  ["invoices: discount", CreateInvoiceDto, "discount", 0],
  ["invoices: shippingFee", CreateInvoiceDto, "shippingFee", 0],
  ["invoices: payment bankCharges", RecordInvoicePaymentDto, "bankCharges", 0],
  ["invoices: PATCH discount (PartialType)", UpdateInvoiceDto, "discount", 0],
  ["invoices: PATCH shippingFee (PartialType)", UpdateInvoiceDto, "shippingFee", 0],
  ["estimates: line unitPrice", CreateEstimateItemDto, "unitPrice", 0],
  ["credit-notes: apply amount", ApplyCreditNoteDto, "amount", 1],
  ["recurring-invoices: shippingFee", CreateRecurringInvoiceDto, "shippingFee", 0],
  ["recurring-invoices: PATCH discount (PartialType)", UpdateRecurringInvoiceDto, "discount", 0],
  [
    "recurring-invoices: PATCH shippingFee (PartialType)",
    UpdateRecurringInvoiceDto,
    "shippingFee",
    0,
  ],
  ["vendor-bills: line unitCost", VendorBillItemDto, "unitCost", 0],
  ["vendor-bills: taxAmount", CreateVendorBillDto, "taxAmount", 0],
  ["vendor-bills: PATCH taxAmount", UpdateVendorBillDto, "taxAmount", 0],
  ["returns: approve amount", ApproveInlineReturnDto, "amount", 1],
  ["returns: credit unit price", CaptureInlineReturnItemDto, "creditUnitPrice", 0],
  ["bookkeeping: expense amount", UpdateExpenseDto, "amount", 1],
  ["payments: advance-payment amount", ApplyAdvancePaymentDto, "amount", 1],
  ["inventory: PO case cost", PurchaseOrderItemDto, "caseCost", 0],
  ["inventory: variant unit cost override", VariantAssignmentDto, "unitCostOverride", 0],
  ["import: setup price", CompleteSetupDto, "pricePerUnit", 0],
  ["promotions: PATCH value (PartialType)", UpdatePromotionDto, "value", 0],
  ["sales-agents: default rate", CreateSalesAgentDto, "defaultRatePct", 0],
  ["tracked-categories: rate", CreateTrackedCategoryDto, "rate", 0],
];

describe("money DTO fields: undefined = absent, 0 = valid, null = 400", () => {
  it.each(REFUSES_NULL)("%s", async (_label, Dto, prop, valid) => {
    expect((await messagesFor(Dto, { [prop]: null }, prop)).length).toBeGreaterThan(0);
    expect(await messagesFor(Dto, {}, prop)).toEqual([]);
    expect(await messagesFor(Dto, { [prop]: valid }, prop)).toEqual([]);
  });
});

describe("kept null-tolerant fields behave as documented", () => {
  it("PATCH invoice depositPercent: null still validates (it clears the deposit)", async () => {
    expect(await messagesFor(UpdateInvoiceDto, { depositPercent: null }, "depositPercent")).toEqual(
      [],
    );
  });

  it("customer creditLimit: null still validates (it clears the limit)", async () => {
    expect(await messagesFor(UpdateCustomerDto, { creditLimit: null }, "creditLimit")).toEqual([]);
  });

  it("product decimal strings: null becomes absent before validation, never a value", async () => {
    const dto = plainToInstance(CreateProductDto, { priceTier2: null, standardCost: null });
    expect(dto.priceTier2).toBeUndefined();
    expect(dto.standardCost).toBeUndefined();
    expect(await messagesFor(CreateProductDto, { priceTier2: null }, "priceTier2")).toEqual([]);
  });
});

describe("IsOptionalNotNull", () => {
  it("is a property decorator that skips validation only for undefined", async () => {
    class Probe {
      @IsOptionalNotNull() @IsNumber() n?: number;
    }
    expect(await messagesFor(Probe, { n: null }, "n")).not.toEqual([]);
    expect(await messagesFor(Probe, {}, "n")).toEqual([]);
    expect(await messagesFor(Probe, { n: 0 }, "n")).toEqual([]);
    expect(await messagesFor(Probe, { n: "x" }, "n")).not.toEqual([]);
  });
});
