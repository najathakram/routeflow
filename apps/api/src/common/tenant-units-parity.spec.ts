/**
 * Units U-6: the backfill script is plain CommonJS and cannot import TypeScript, so it carries ports of
 * two things U-1 owns. This spec pins each port to its original (SA-797 G1, SA-810):
 *   - `unitNameKey` (`packages/pricing`): NFC, then trim, then case-fold. The planner must key a unit
 *     name EXACTLY as the units service does, or the backfill makes a second unit for a spelling the
 *     service already sees as one (and the unique (tenantId, nameKey) never catches it);
 *   - `MAX_ACTIVE_TENANT_UNITS` (`apps/api/src/units/unit-room.ts`): the 200-unit cap.
 * The original is read live whenever it exists in this tree. U-1 (#3337) lands them; until it does the
 * live arm is reported as skipped and the golden arm (fixed expectations written from the JS rules)
 * still runs. A different normaliser in the script goes red on the golden arm today.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  unitNameKey: ported,
  MAX_ACTIVE_TENANT_UNITS: portedCap,
} = require("../../scripts/lib/tenant-units-plan.cjs");

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

  const pricing = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("@routeflow/pricing") as { unitNameKey?: (s: string) => string };
    } catch {
      return {};
    }
  })();
  const liveKey = typeof pricing.unitNameKey === "function" ? it : it.skip;
  liveKey.each(FIXTURES)(
    "live: the port equals packages/pricing unitNameKey on %s",
    (_l, input) => {
      expect(ported(input)).toBe(pricing.unitNameKey!(input));
    },
  );

  const room = path.resolve(__dirname, "../units/unit-room.ts");
  it("pins the cap at SA-810's 200", () => {
    expect(portedCap).toBe(200);
  });
  (existsSync(room) ? it : it.skip)("live: the cap equals U-1's MAX_ACTIVE_TENANT_UNITS", () => {
    const m = /export const MAX_ACTIVE_TENANT_UNITS\s*=\s*(\d+)\s*;/.exec(
      readFileSync(room, "utf8"),
    );
    expect(m).not.toBeNull();
    expect(portedCap).toBe(Number(m![1]));
  });
});
