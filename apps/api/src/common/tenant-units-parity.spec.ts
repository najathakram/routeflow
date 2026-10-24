/**
 * Units U-6: the backfill script is plain CommonJS and cannot import TypeScript, so it carries copies
 * of what U-1 owns. This spec pins each copy to its original so they cannot drift (SA-797 G1, SA-810):
 *   - `unitNameKey` (`packages/pricing`): NFC, then trim, then case-fold. The planner must key a unit
 *     name EXACTLY as the units service does, or the backfill makes a second unit for a spelling the
 *     service already sees as one (and the unique (tenantId, nameKey) never catches it);
 *   - `MAX_ACTIVE_TENANT_UNITS` (`apps/api/src/units/unit-room.ts`): the 200-unit cap;
 *   - `PIECE_SYNONYMS` (`apps/api/src/units/piece-words.ts`) and the 30-character name limit
 *     (`MAX_UNIT_NAME_LENGTH` in units.service.ts and the DTOs' `@MaxLength(30)`);
 *   - the ladder lock SQL (`apps/api/src/units/tenant-units-lock.ts`): the apply step issues the same
 *     statements `lockProductPack` / `lockTenantUnits` do. U-1's own functions are RUN against a
 *     recording executor and the statements compared, so a changed key, family or argument order in
 *     U-1 turns this red.
 * U-1 is on master, so every arm reads the original live: nothing is skipped.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { unitNameKey as pricingUnitNameKey } from "@routeflow/pricing";
import { PIECE_SYNONYMS as API_PIECE_SYNONYMS } from "../units/piece-words";
import { lockProductPack, lockTenantUnits } from "../units/tenant-units-lock";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  unitNameKey: ported,
  MAX_ACTIVE_TENANT_UNITS: portedCap,
  MAX_NAME_LENGTH: portedMaxName,
  PIECE_SYNONYMS: portedSynonyms,
} = require("../../scripts/lib/tenant-units-plan.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  TENANT_UNITS_LOCK_SQL,
  PRODUCT_UNITS_LOCK_SQL,
} = require("../../scripts/lib/tenant-units-apply.cjs");

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");

const FIXTURES: Array<[label: string, input: string, key: string]> = [
  ["Café NFC", "Café", "café"],
  ["Cafe + U+0301 NFD", "Café", "café"],
  ["ÉTUI", "ÉTUI", "étui"],
  ["E + U+0301 + TUI", "ÉTUI", "étui"],
  ["NBSP padded", " Case ", "case"],
  ["Straße", "Straße", "straße"],
  ["STRASSE", "STRASSE", "strasse"],
  ["trailing spaces", "Case   ", "case"],
  ["tab, LF and ideographic space", "\t\nCase　", "case"],
  ["BOM and em space", "﻿ Case", "case"],
  ["empty", "", ""],
  ["only whitespace", "   ", ""],
  ["dotted capital I", "İ", "i̇"],
];

describe("tenant-units-plan.cjs ports (U-6)", () => {
  it.each(FIXTURES)("golden: %s", (_label, input, key) => {
    expect(ported(input)).toBe(key);
  });

  it.each(FIXTURES)("live: the port equals packages/pricing unitNameKey on %s", (_l, input) => {
    expect(ported(input)).toBe(pricingUnitNameKey(input));
  });

  it("pins the cap at SA-810's 200", () => {
    expect(portedCap).toBe(200);
  });
  it("live: the cap equals U-1's MAX_ACTIVE_TENANT_UNITS", () => {
    const m = /export const MAX_ACTIVE_TENANT_UNITS\s*=\s*(\d+)\s*;/.exec(
      read("../units/unit-room.ts"),
    );
    expect(m).not.toBeNull();
    expect(portedCap).toBe(Number(m![1]));
  });

  it("live: the Piece synonyms equal piece-words.ts (same words)", () => {
    expect([...portedSynonyms].sort()).toEqual([...API_PIECE_SYNONYMS].sort());
  });

  it("live: the 30-character limit equals MAX_UNIT_NAME_LENGTH and both DTOs' @MaxLength", () => {
    expect(portedMaxName).toBe(30);
    const svc = /export const MAX_UNIT_NAME_LENGTH\s*=\s*(\d+)\s*;/.exec(
      read("../units/units.service.ts"),
    );
    expect(svc).not.toBeNull();
    expect(portedMaxName).toBe(Number(svc![1]));
    for (const dto of ["create-unit.dto.ts", "update-unit.dto.ts"]) {
      const m = /@MaxLength\((\d+)\b/.exec(read(`../units/dto/${dto}`));
      expect(m).not.toBeNull();
      expect(portedMaxName).toBe(Number(m![1]));
    }
  });

  describe("the ladder locks equal tenant-units-lock.ts", () => {
    /** Collects the tagged-template statements, each rendered with its values inlined as '...'. */
    const recorder = () => {
      const statements: string[] = [];
      const render = (strings: TemplateStringsArray, values: unknown[]) =>
        strings.reduce(
          (acc, str, i) => acc + str + (i < values.length ? `'${values[i]}'` : ""),
          "",
        );
      return {
        statements,
        tx: {
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            statements.push(render(strings, values));
            return 0;
          },
        },
      };
    };
    /** The script's SQL with $1 inlined the same way. */
    const script = (sql: string, id: string) => sql.replace("$1", `'${id}'`);
    const advisory = (statements: string[]) => statements.filter((s) => s.includes("advisory"));

    it("lockProductPack takes the tenant lock SHARED, then the product's, in the script's text", async () => {
      const r = recorder();
      await lockProductPack(r.tx, "TENANT-1", "PRODUCT-1");
      expect(advisory(r.statements)).toEqual([
        script(TENANT_UNITS_LOCK_SQL, "TENANT-1"),
        script(PRODUCT_UNITS_LOCK_SQL, "PRODUCT-1"),
      ]);
    });

    it("lockTenantUnits(shared) is the script's tenant statement; exclusive is a different one", async () => {
      const shared = recorder();
      await lockTenantUnits(shared.tx, "TENANT-1", "shared");
      expect(advisory(shared.statements)).toEqual([script(TENANT_UNITS_LOCK_SQL, "TENANT-1")]);
      const exclusive = recorder();
      await lockTenantUnits(exclusive.tx, "TENANT-1", "exclusive");
      expect(advisory(exclusive.statements)).not.toEqual(advisory(shared.statements));
    });

    it("the script takes the SHARED tenant lock, never the exclusive one a rename takes", () => {
      expect(TENANT_UNITS_LOCK_SQL).toContain("pg_advisory_xact_lock_shared(");
      expect(PRODUCT_UNITS_LOCK_SQL).not.toContain("_shared");
    });
  });
});
