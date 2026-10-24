import { readFileSync } from "fs";
import { join } from "path";

/** H3b (SA): both invoice save paths show the fixed safe-text copy before any server message. */
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("mobile invoice save errors use the fixed safe-text copy", () => {
  it.each([
    ["app/(operator)/(tabs)/invoices/new.tsx"],
    ["app/(operator)/(tabs)/invoices/[id]/edit.tsx"],
  ])("%s", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/import \{ safeTextErrorCopy \} from "[./]+lib\/safe-text-error-copy";/);
    expect(src).toMatch(/safeTextErrorCopy\((err|e)\) \?\? (err|e)\?\.response\?\.data\?\.message/);
  });
});
