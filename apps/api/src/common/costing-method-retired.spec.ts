import * as fs from "fs";
import * as path from "path";
import {
  RETIRED_COSTING_METHODS as RETIRED_LOCAL,
  assertCostingMethodAllowed,
  effectiveCostingMethod,
  isRetiredCostingMethod,
} from "../inventory/costing-method-policy";
import { API_ERROR_CODES } from "./api-error-codes";

/**
 * SA-804 (1) / B1232 + B1233: FIFO and LIFO are RETIRED costing methods. They stay in the Prisma enum
 * (no enum migration; old rows keep their value) but no write may SET them, and a stored one is costed as
 * AVCO. This census pin keeps that true as code is added:
 *
 *   1. the API's literal mirror of RETIRED_COSTING_METHODS equals the shared one;
 *   2. every non-spec file under apps/api/src that WRITES a costing method (a `costingMethod: <value>` site,
 *      or a `costing.method` SystemConfig set) is classified here: either it goes through the single
 *      validator module (`inventory/costing-method-policy.ts`) or it is allow-listed with a reason. A new
 *      writer that is neither fails this spec;
 *   3. the only DTOs that accept `costingMethod` are the product create/update ones, and the service they
 *      reach validates;
 *   4. no production source spells "FIFO"/"LIFO" as a value (a hard-coded `CostingMethod.FIFO`, a string
 *      literal) outside the policy module and the one allow-listed tenant-key map.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SRC = path.join(REPO_ROOT, "apps", "api", "src");
const POLICY_REL = "inventory/costing-method-policy.ts";

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "testing") continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const files: { rel: string; text: string }[] = [];
{
  const abs: string[] = [];
  walk(SRC, abs);
  for (const f of abs) {
    files.push({
      rel: path.relative(SRC, f).split(path.sep).join("/"),
      text: withoutComments(fs.readFileSync(f, "utf8")),
    });
  }
}

/**
 * A "write site": `costingMethod: <anything but a bare `true` select or a type name>` or a SystemConfig set of
 * `costing.method`. (`costingMethod?: X` and `costingMethod: CostingMethod;` are type declarations, not writes.)
 */
const WRITE_SITE =
  /\bcostingMethod\s*:\s*(?!\s)(?!true\b)(?!CostingMethod\b)(?!"WEIGHTED_AVERAGE")|\bset\(\s*["']costing\.method["']/;

/** Files that write (or copy) a costing method and so MUST go through the validator module. */
const VALIDATED = new Set([
  "products/products.service.ts", // create + update: assertCostingMethodAllowed; variant inherit: effectiveCostingMethod
  "system-config/system-config.service.ts", // setMarginConfig: assertCostingMethodAllowed
  "inventory/inventory.service.ts", // variant split copies the parent: effectiveCostingMethod
  "import/variant-resolution.service.ts", // scan/import variant copies the parent: effectiveCostingMethod
]);

/** Files with a `costingMethod:` site that does NOT write a product or tenant costing method. */
const READ_ONLY: Record<string, string> = {
  "common/invoiced-sales.ts": "builds the cost facts object from a product row it just read",
};

describe("retired costing methods FIFO / LIFO (SA-804 (1), B1232)", () => {
  it("the API's literal mirror equals the shared RETIRED_COSTING_METHODS", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as Record<string, unknown>;
    expect([...RETIRED_LOCAL]).toEqual([...(shared.RETIRED_COSTING_METHODS as string[])]);
    expect([...RETIRED_LOCAL]).toEqual(["FIFO", "LIFO"]);
  });

  it("the shared SELECTABLE list is exactly the enum minus the retired pair", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as Record<string, string[]>;
    const rest = shared.COSTING_METHOD_VALUES.filter((m) => !RETIRED_LOCAL.includes(m as never));
    expect([...shared.SELECTABLE_COSTING_METHODS].sort()).toEqual([...rest].sort());
  });

  it("COSTING_METHOD_RETIRED is a registered error code", () => {
    expect(API_ERROR_CODES.COSTING_METHOD_RETIRED).toBe("COSTING_METHOD_RETIRED");
  });

  describe("the validator", () => {
    it.each(["FIFO", "LIFO"])("refuses %s with 400 COSTING_METHOD_RETIRED", (m) => {
      try {
        assertCostingMethodAllowed(m);
        throw new Error("did not throw");
      } catch (e: any) {
        expect(e.getStatus()).toBe(400);
        expect(e.getResponse()).toMatchObject({ code: "COSTING_METHOD_RETIRED" });
      }
    });

    it.each(["AVCO", "STANDARD", "LAST_COST", undefined, null])("allows %s", (m) => {
      expect(() => assertCostingMethodAllowed(m as string | undefined)).not.toThrow();
    });

    it("allows re-sending the value a row already stores (a no-op, not a set)", () => {
      expect(() => assertCostingMethodAllowed("FIFO", "FIFO")).not.toThrow();
      expect(() => assertCostingMethodAllowed("LIFO", "FIFO")).toThrow();
      expect(() => assertCostingMethodAllowed("FIFO", "AVCO")).toThrow();
    });

    it("costs a stored FIFO/LIFO as AVCO and leaves the rest alone", () => {
      expect(effectiveCostingMethod("FIFO" as never)).toBe("AVCO");
      expect(effectiveCostingMethod("LIFO" as never)).toBe("AVCO");
      expect(effectiveCostingMethod("STANDARD" as never)).toBe("STANDARD");
      expect(effectiveCostingMethod("LAST_COST" as never)).toBe("LAST_COST");
      expect(effectiveCostingMethod(undefined)).toBeUndefined();
      expect(isRetiredCostingMethod("AVCO")).toBe(false);
    });
  });

  describe("census: every writer of a costing method goes through the validator or is allow-listed", () => {
    const writers = files.filter((f) => f.rel !== POLICY_REL && WRITE_SITE.test(f.text));

    it("the scan sees the known writers (guards a path typo turning it vacuous)", () => {
      const rels = writers.map((w) => w.rel);
      for (const v of VALIDATED) expect(rels).toContain(v);
    });

    it.each(writers.map((w) => [w.rel, w.text] as const))("%s is classified", (rel, text) => {
      if (VALIDATED.has(rel)) {
        expect(text).toMatch(/from\s+["'][./]*(?:inventory\/)?costing-method-policy["']/);
        expect(text).toMatch(/\b(assertCostingMethodAllowed|effectiveCostingMethod)\(/);
      } else {
        // Not on either list = a NEW writer of a costing method that skips the validator.
        expect(Object.keys(READ_ONLY)).toContain(rel);
      }
    });

    it("an allow-listed read-only entry still exists and carries a reason", () => {
      for (const [rel, reason] of Object.entries(READ_ONLY)) {
        expect(files.some((f) => f.rel === rel)).toBe(true);
        expect(reason.length).toBeGreaterThan(10);
      }
    });

    it("every validated file really calls the validator for the tenant key / product writes it owns", () => {
      const sys = files.find((f) => f.rel === "system-config/system-config.service.ts")!;
      expect(sys.text).toMatch(/assertCostingMethodAllowed\(\s*dto\.costingMethod/);
      const prod = files.find((f) => f.rel === "products/products.service.ts")!;
      expect(prod.text.match(/assertCostingMethodAllowed\(\s*dto\.costingMethod/g)?.length).toBe(2);
    });
  });

  describe("DTO census: only the product create/update DTOs accept costingMethod", () => {
    it("no other DTO declares the field", () => {
      const dtoFiles = files
        .filter((f) => /\.dto\.ts$/.test(f.rel) && /\bcostingMethod\b/.test(f.text))
        .map((f) => f.rel)
        .sort();
      expect(dtoFiles).toEqual([
        "products/dto/create-product.dto.ts",
        "products/dto/update-product.dto.ts",
      ]);
    });
  });

  describe("no hard-coded retired value anywhere else", () => {
    /** Keys of the tenant `costing.method` map: a stored tenant FIFO maps to AVCO, it never sets FIFO. */
    const ALLOW: Record<string, string> = {
      "products/products.service.ts":
        "TENANT_COSTING_TO_PRODUCT maps the stored tenant key FIFO to AVCO",
    };
    const RETIRED_VALUE =
      /(["'`])(?:FIFO|LIFO)\1|\bCostingMethod\.(?:FIFO|LIFO)\b|^\s*(?:FIFO|LIFO)\s*:/m;

    it("production source never spells FIFO/LIFO as a value outside the policy module", () => {
      const offenders = files
        .filter((f) => f.rel !== POLICY_REL && RETIRED_VALUE.test(f.text))
        .map((f) => f.rel)
        .filter((rel) => !(rel in ALLOW));
      expect(offenders).toEqual([]);
    });

    it("the allow-listed map still maps FIFO to AVCO (not to FIFO)", () => {
      const prod = files.find((f) => f.rel === "products/products.service.ts")!;
      expect(prod.text).toMatch(/FIFO:\s*CostingMethod\.AVCO/);
      expect(prod.text).not.toMatch(/CostingMethod\.(FIFO|LIFO)/);
    });
  });

  describe("the read side: a sale never consumes lots", () => {
    it("sale-movement.ts no longer plans lot consumption for any method", () => {
      const sm = files.find((f) => f.rel === "inventory/sale-movement.ts")!;
      expect(sm.text).not.toMatch(/planLotConsumption|stockLot|lotConsumptions/);
    });
  });
});
