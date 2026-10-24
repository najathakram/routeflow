/**
 * SA-750r3 — static guard: `tillLockHeld` (skip the shared close-lock statement in `recordPayment`) is only sound for a caller
 * that already holds that lock on its pinned connection. Only the counter tender and the pickup hand-over do; the two files that
 * DEFINE it are the guard and the invoices service. Any other production file mentioning it fails here.
 *
 * Excluded: `*.spec.ts` (they pass the option as data).
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const rel = (f: string) => path.relative(SRC_ROOT, f).split(path.sep).join("/");

const ALLOWED = new Set([
  "orders/counter-sale/counter-sale.service.ts",
  "orders/counter-sale/pickup-complete.service.ts",
  "invoices/counter-payment-guard.ts",
  "invoices/invoices.service.ts",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") sourceFiles(full, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("tillLockHeld callers (static pin)", () => {
  const mentioning = sourceFiles(SRC_ROOT)
    .filter((f) => /tillLockHeld|TILL_LOCK_HELD/.test(fs.readFileSync(f, "utf8")))
    .map(rel);

  it("only the counter tender, the pickup hand-over and the files that define it mention it", () => {
    expect(mentioning.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it("the allow-list is live: both tender callers still pass it (a stale entry would hide a regression)", () => {
    expect(mentioning).toEqual(expect.arrayContaining([...ALLOWED]));
  });
});
