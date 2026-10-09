import * as fs from "fs";
import * as path from "path";

/**
 * SA-733 D9 pin: every Stripe amount in billing goes through `toCents` / `fromCents` from
 * `@routeflow/pricing`. A hand-written `* 100` (or a local copy of the helper) is how a cent drifts:
 * `Math.round(1.005 * 100)` is 100 while the shared helper gives 101. Source scan, comments skipped.
 */
/** Every non-spec .ts under `dir`, recursively (billing/rf-invoice, billing/dto, ...), as `{ f: path-from-src, text }`. */
function scan(dir: string): { f: string; text: string }[] {
  const out: { f: string; text: string }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...scan(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts"))
      out.push({
        f: path.relative(SRC, full).split(path.sep).join("/"),
        text: fs.readFileSync(full, "utf8"),
      });
  }
  return out;
}
const SRC = path.resolve(__dirname, "..");
// Billing (every subdirectory) AND platform-admin: the admin price paths build Stripe amounts too.
const sources = [...scan(__dirname), ...scan(path.join(SRC, "platform-admin"))];

/**
 * Lines that are `* 100` / `/ 100` but NOT money. Each needs a reason, and a zero-match error below: an entry
 * that no longer matches any line is stale and must be deleted, never left to hide a future real hit.
 */
const NOT_MONEY: { file: string; line: string; reason: string }[] = [
  {
    file: "platform-admin/platform-config.service.ts",
    line: "estSpendUsd: Math.round(estSpendUsd * 100) / 100,",
    reason:
      "a display rounding of an AI-spend ESTIMATE in USD (not a Stripe amount, not a ledger write)",
  },
];
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""));

describe("billing money: no bare cents arithmetic (SA-733 D9)", () => {
  it("there are billing sources to scan", () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it("the scan reaches the billing subdirectories and platform-admin", () => {
    const files = sources.map((s) => s.f);
    expect(files.some((f) => f.startsWith("billing/rf-invoice/"))).toBe(true);
    expect(files.some((f) => f.startsWith("billing/dto/"))).toBe(true);
    expect(files.some((f) => f.startsWith("platform-admin/"))).toBe(true);
  });

  it("every NOT_MONEY allow-list entry still matches a line (a stale entry is an error)", () => {
    for (const n of NOT_MONEY) {
      const src = sources.find((s) => s.f === n.file);
      expect(src).toBeDefined();
      expect(code(src!.text).some((l) => l.includes(n.line))).toBe(true);
      expect(n.reason.length).toBeGreaterThan(10);
    }
  });

  it("no `* 100` / `/ 100` in a non-spec billing or platform-admin source", () => {
    const hits: string[] = [];
    for (const { f, text } of sources)
      code(text).forEach((line, i) => {
        if (
          /[*/]\s*100(?![\d.])/.test(line) &&
          !NOT_MONEY.some((n) => n.file === f && line.includes(n.line))
        )
          hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    expect(hits).toEqual([]);
  });

  it("toCents / fromCents are defined nowhere in billing (they come from @routeflow/pricing)", () => {
    const hits = sources
      .filter(({ text }) => /(function|const)\s+(toCents|fromCents)\b/.test(code(text).join("\n")))
      .map(({ f }) => f);
    expect(hits).toEqual([]);
  });
});
