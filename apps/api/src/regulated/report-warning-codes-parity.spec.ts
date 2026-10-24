import * as fs from "fs";
import * as path from "path";
import { REPORT_WARNING_CODES } from "./report-types";

/**
 * B987-D: the regulated-report warning codes are sent by the API (`ReportWarning.code`) and typed by web and mobile through
 * `RegulatedReportWarningCode` in `@routeflow/types`. The API cannot value-import that package (see
 * `no-runtime-workspace-imports.spec.ts`), so it keeps a local copy of the list, pinned here against the shared one: same members
 * AND the same order, so a code added on one side only (as PARKED_REVERSALS once was) fails this spec instead of reaching a
 * client whose type has never heard of it.
 */
function readShared(): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = require("@routeflow/types") as Record<string, unknown>;
  return (shared.REGULATED_REPORT_WARNING_CODES ?? []) as readonly string[];
}

describe("regulated report warning codes: API copy = shared list (B987-D)", () => {
  it("the shared list exists and is non-empty (guards a missing export turning the pin vacuous)", () => {
    expect(readShared().length).toBeGreaterThan(0);
  });

  it("the API's REPORT_WARNING_CODES equals @routeflow/types' REGULATED_REPORT_WARNING_CODES (members and order)", () => {
    expect([...REPORT_WARNING_CODES]).toEqual([...readShared()]);
  });

  it("has no duplicates and every code is UPPER_SNAKE", () => {
    expect(new Set(REPORT_WARNING_CODES).size).toBe(REPORT_WARNING_CODES.length);
    for (const c of REPORT_WARNING_CODES) expect(c).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });
});

/**
 * B987-D: no client maps a warning CODE to display text. The web panel and the mobile section both render `w.message`, the
 * complete human sentence the API composes ("ready to render in the UI"), so a newly typed code such as PARKED_REVERSALS can
 * never show as a raw code or an undefined label. If a client ever adds a code -> label map, it must carry copy for every member
 * of REGULATED_REPORT_WARNING_CODES (extend this pin then); until then rendering `w.code` is refused.
 */
describe("regulated report warnings are rendered from the message, never the raw code (B987-D)", () => {
  const REPO = path.resolve(__dirname, "../../../..");
  const CLIENTS = [
    "apps/web/components/RegulatedReportPanel.tsx",
    "apps/mobile/components/RegulatedReportSection.tsx",
  ];
  /** A read of a warning's `code` in a render position: `w.code`, `warning.code`, or an index by it. */
  const READS_CODE = /\b(?:w|warn|warning|item)\??\.code\b|\[\s*(?:w|warn|warning)\??\.code\s*\]/;

  it.each(CLIENTS)("%s renders w.message and never reads a warning's code", (rel) => {
    const src = fs.readFileSync(path.join(REPO, rel), "utf8");
    expect(src).toMatch(/\bw\.message\b/);
    expect(src).not.toMatch(READS_CODE);
  });

  it("mutation-proof: the pattern catches a code read in the common spellings and not a message read", () => {
    for (const planted of [
      "<li>{w.code}</li>",
      "LABELS[w.code]",
      "w?.code ?? x",
      "warning.code",
      "map[ warn.code ]",
    ])
      expect(planted).toMatch(READS_CODE);
    for (const ok of ["<li>{w.message}</li>", "const code = x.code", "w.messages"])
      expect(ok).not.toMatch(READS_CODE);
  });
});
