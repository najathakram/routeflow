import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1102 F-1102-T (the class, web side): the places a business scans (bill scan modal, statements, route notes) never
 * say an Anthropic key is "not configured" or send the business to add one. Only a business's OWN refused key is the
 * business's to fix, and it reads "refused" (see scan-failure-copy.ts). The API sites are pinned in
 * `ai-sites.failure-text.spec.ts`.
 */
const root = join(__dirname, "..");
const SEATS = [
  "components/ScanInvoiceModal.tsx",
  "lib/scan-failure-copy.ts",
  "app/(dashboard)/finance/statements/page.tsx",
  "app/(dashboard)/routes/templates/[id]/page.tsx",
  "app/(dashboard)/routes/_components/AiRouteNotice.tsx",
];

describe("no 'key not configured' text where a business scans", () => {
  it.each(SEATS)("%s", (file) => {
    const text = readFileSync(join(root, file), "utf8");
    expect([
      file,
      text.match(
        /Anthropic API key not configured|add your Claude API key|Configure an Anthropic|not configured\b[^"`']*Anthropic/i,
      )?.[0] ?? null,
    ]).toEqual([file, null]);
  });
});
