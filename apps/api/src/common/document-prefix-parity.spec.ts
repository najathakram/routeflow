import { join } from "path";
import * as api from "./document-prefix";

/**
 * B1188: web mirrors the API's document-prefix rule (the API cannot value-import
 * `@routeflow/types`, see no-runtime-workspace-imports.spec.ts). Same pattern as enum-parity.spec.ts:
 * ONE table of prefixes runs against BOTH implementations, and the verdicts AND the messages must
 * be identical. Loaded by path (web is not an api dependency); a type-free require keeps the api
 * compile graph out of apps/web.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const web: typeof api = require(join(__dirname, "..", "..", "..", "web", "lib", "document-prefix"));

const TABLE: unknown[] = [
  "INV-",
  "EST-",
  "CN-",
  "2026-",
  "A/B-",
  "INV.",
  "INV_",
  "A",
  "INV-2026-",
  "A".repeat(16),
  "A".repeat(15) + "-",
  "A".repeat(17),
  "INV2",
  "7",
  "AB-9",
  "INV-2026",
  "",
  "IN V-",
  "INV;",
  "INV'-",
  "INV%",
  "ÉCOLE-",
  "INV\n",
  "#",
  "-INV-",
  "/X-",
  ".X-",
  "_X-",
  null,
  undefined,
  42,
  {},
];

describe("document prefix rule: api and web mirror are identical (B1188)", () => {
  it("exports the same max length", () => {
    expect(web.DOCUMENT_PREFIX_MAX_LENGTH).toBe(api.DOCUMENT_PREFIX_MAX_LENGTH);
  });

  it.each(TABLE.map((v) => [JSON.stringify(v) ?? String(v), v]))(
    "same verdict and message for %s",
    (_label, value) => {
      expect(web.validateDocumentPrefix(value)).toBe(api.validateDocumentPrefix(value));
    },
  );

  it("the table exercises both outcomes (guards a vacuous table)", () => {
    const verdicts = TABLE.map((v) => api.validateDocumentPrefix(v) === null);
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});
