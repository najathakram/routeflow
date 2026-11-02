import * as fs from "node:fs";
import * as path from "node:path";
import { API_SRC_ROOT, codeOnly, collectSourceFiles } from "../testing/source-scan";
import type { PrismaService } from "../prisma/prisma.service";
import {
  CUSTOMER_IDENTITY_OMIT,
  CUSTOMER_IDENTITY_READERS,
  last4,
  maskedIdentity,
} from "./customer-identity-fields";

/**
 * SA-1084 (SI-8) tripwire. The three identity columns are left out of every customer and authorization read by a
 * global omit, so a new reader has to name the column on purpose. This pin makes that a review step: every non-spec
 * file under `apps/api/src` whose code names `taxId`, `tobaccoLicenseNo` or `licenseNumber` is listed in
 * `CUSTOMER_IDENTITY_READERS` with a reason, and nothing is listed that no longer names one.
 */

const NAMES_FIELD = /\b(taxId|tobaccoLicenseNo|licenseNumber)\b/;

function rel(full: string): string {
  return path.relative(API_SRC_ROOT, full).split(path.sep).join("/");
}

/** Non-spec source files, as `{ rel, text }`, whose code (comments blanked) names an identity column. */
export function filesNamingIdentityFields(files: Array<{ rel: string; text: string }>): string[] {
  return files.filter(({ text }) => NAMES_FIELD.test(codeOnly(text))).map(({ rel: r }) => r);
}

describe("customer identity fields: reader inventory (SA-1084)", () => {
  it("detector: flags code that names a column, ignores a comment and a lookalike", () => {
    const named = (text: string) => filesNamingIdentityFields([{ rel: "a.ts", text }]);
    expect(named("select: { taxId: true }")).toEqual(["a.ts"]);
    expect(named("const x = row.tobaccoLicenseNo;")).toEqual(["a.ts"]);
    expect(named("data: { licenseNumber }")).toEqual(["a.ts"]);
    expect(named("// taxId is private\nconst a = 1;")).toEqual([]);
    expect(named("/* licenseNumber */ const a = 1;")).toEqual([]);
    expect(named("const taxIdLast4 = 1; const mytaxIds = 2;")).toEqual([]);
  });

  it("every file that names an identity column is listed with a reason, and every entry is real", () => {
    const files = collectSourceFiles().map((full) => ({
      rel: rel(full),
      text: fs.readFileSync(full, "utf8"),
    }));
    // an empty scan must never report green
    expect(files.map((f) => f.rel)).toContain("customers/customers.service.ts");
    const naming = filesNamingIdentityFields(files).sort();
    const listed = CUSTOMER_IDENTITY_READERS.map((r) => r.file).sort();
    expect({ unlisted: naming.filter((f) => !listed.includes(f)) }).toEqual({ unlisted: [] });
    expect({ stale: listed.filter((f) => !naming.includes(f)) }).toEqual({ stale: [] });
    expect(new Set(listed).size).toBe(listed.length);
    for (const r of CUSTOMER_IDENTITY_READERS) expect(r.reason.trim().length).toBeGreaterThan(10);
  });

  it("the registry omits exactly the three columns", () => {
    expect(CUSTOMER_IDENTITY_OMIT).toEqual({
      customer: { taxId: true, tobaccoLicenseNo: true },
      customerAuthorization: { licenseNumber: true },
    });
  });

  it("last4 and maskedIdentity never return more than 4 characters", () => {
    expect(last4("12-3456789")).toBe("6789");
    expect(last4("  TL-0042 ")).toBe("0042");
    expect(last4("123")).toBe("123");
    expect(last4("")).toBeNull();
    expect(last4("   ")).toBeNull();
    expect(last4(null)).toBeNull();
    expect(last4(undefined)).toBeNull();
    expect(maskedIdentity("12-3456789")).toBe("6789");
    expect(maskedIdentity(12345)).toBeNull();
    expect(maskedIdentity(null)).toBeNull();
  });
});

/**
 * Type pin: the client's result types follow the runtime omit. A plain `include` result must NOT carry the three
 * columns, so a future reader that forgets to name one fails to compile instead of reading `undefined` at runtime.
 * (`tsc` is the judge; the `@ts-expect-error` lines turn red if the omit ever stops reaching the types. The
 * function is never called.)
 */
async function typesFollowTheOmit(db: PrismaService) {
  const plain = await db.customer.findFirstOrThrow({ include: { addresses: true } });
  // @ts-expect-error the plain row has no taxId
  void plain.taxId;
  // @ts-expect-error the plain row has no tobaccoLicenseNo
  void plain.tobaccoLicenseNo;
  const named = await db.customer.findFirstOrThrow({ select: { taxId: true } });
  void named.taxId;
  const authorization = await db.customerAuthorization.findFirstOrThrow();
  // @ts-expect-error the plain authorization has no licenseNumber
  void authorization.licenseNumber;
}

describe("customer identity fields: types follow the omit (SA-1084)", () => {
  it("is compiled by tsc, not run", () => {
    expect(typeof typesFollowTheOmit).toBe("function");
  });
});
