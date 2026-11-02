import type { Prisma } from "@prisma/client";

/**
 * SA-1084: the customer identity fields a query leaves out unless it asks for them by name.
 * `PrismaService` hands `CUSTOMER_IDENTITY_OMIT` to the client as a GLOBAL omit, so a plain `findMany`, an
 * `include` and every `customer: true` stop carrying these columns, today's and tomorrow's. A reader that needs
 * the stored value names the field in a `select` (or `omit: { <field>: false }`) and is listed in
 * `CUSTOMER_IDENTITY_READERS` with its reason; `customer-identity-fields.pin.spec.ts` fails on any other file.
 * Responses never carry the raw value: staff and the buyer get `taxIdLast4` (built by `last4`), a driver nothing.
 */
export const CUSTOMER_IDENTITY_OMIT = {
  customer: { taxId: true, tobaccoLicenseNo: true },
  customerAuthorization: { licenseNumber: true },
} as const satisfies Prisma.GlobalOmitConfig;

/** The last 4 characters of a stored identity value; `null` when nothing is on file. */
export function last4(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v ? v.slice(-4) : null;
}

/** What a diff or a warning may say about an identity value: the last 4, never the whole. */
export function maskedIdentity(value: unknown): string | null {
  return typeof value === "string" ? last4(value) : null;
}

export interface CustomerIdentityReader {
  /** Path under `apps/api/src`. */
  file: string;
  reason: string;
}

/**
 * Every non-spec file under `apps/api/src` that names `taxId`, `tobaccoLicenseNo` or `licenseNumber`, with why.
 * Adding a file here is the review step: it is how a new reader of an identity value gets looked at.
 */
export const CUSTOMER_IDENTITY_READERS: readonly CustomerIdentityReader[] = [
  { file: "customers/customer-identity-fields.ts", reason: "the registry and the masking helper" },
  { file: "customers/customer-identity.ts", reason: "builds taxIdLast4 from a server-side select" },
  {
    file: "regulated/regulated-report.service.ts",
    reason: "the TX filing carries the full values on purpose",
  },
  {
    file: "regulated/tx-report.ts",
    reason: "builds the TX report CSV; its warnings show the last 4 only",
  },
  {
    file: "authorizations/authorizations.service.ts",
    reason: "the staff authorizations tab and the buyer's own licenses page",
  },
  {
    file: "import/import.service.ts",
    reason: "compares an uploaded value with the stored one; reports the last 4",
  },
  {
    file: "customers/customers.service.ts",
    reason: "writes a typed tax ID or license; the reply never carries the stored value",
  },
  {
    file: "customers/customer-update-data.ts",
    reason: "write path: maps the update DTO onto the row",
  },
  {
    file: "customers/customer-compliance-input.ts",
    reason: "write path: license number and expiry input",
  },
  { file: "customers/dto/create-customer.dto.ts", reason: "request DTO" },
  { file: "customers/dto/update-customer.dto.ts", reason: "request DTO" },
  { file: "authorizations/dto/create-authorization.dto.ts", reason: "request DTO" },
  { file: "authorizations/dto/renew-authorization.dto.ts", reason: "request DTO" },
  { file: "authorizations/dto/submit-authorization.dto.ts", reason: "request DTO" },
  { file: "common/safe-text-cell.ts", reason: "label for the formula-led-cell guard" },
  { file: "common/text-cell-guards.ts", reason: "change-only license text guard" },
  { file: "import/import-columns.ts", reason: "import column parsing" },
  { file: "import/import-column-aliases.ts", reason: "import column aliases" },
  {
    file: "tobacco/tobacco.service.ts",
    reason: "compliance pack: a customer's license as last 4 only",
  },
];
