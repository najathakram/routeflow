import * as fs from "fs";
import * as path from "path";

/**
 * STRUCTURAL PIN (the READ_ONLY copy class). A READ_ONLY workspace refuses a write with a 403 whose body code is
 * READ_ONLY. A helper that turns an error into user copy and has a generic 401 / 403 / "forbidden" fallback must
 * look at that code FIRST, or it tells a read-only user "you don't have permission". So every web source file that
 * branches on a 401 / 403 (or a "forbidden" kind) must also reference READ_ONLY / `isReadOnlyRefusal` /
 * `readOnlyRefusalCopy`, or sit in the allow-list below with a one-line reason it can never see a write refusal.
 * It reads source text only (comments stripped); it does not prove ORDER - each helper's own test does that.
 */
const WEB_ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "e2e", "coverage"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
/** Files under app/ and components/ that hold error copy; everything directly in lib/ is scanned. */
const COPY_FILE = /(copy|errors?|error-text)\.tsx?$/i;

/** Allow-list: path (relative to apps/web, forward slashes) -> why it never sees a write refusal. */
const NEVER_SEES_WRITE_REFUSALS: Record<string, string> = {
  "lib/api-client.ts": "token-refresh interceptor on 401; shows no copy",
  "lib/admin-api.ts": "platform-admin token-refresh interceptor on 401; shows no copy",
  "lib/buyer-api-client.ts": "buyer token-refresh interceptor on 401; shows no copy",
  "lib/auth.ts": "clears a presence cookie on a failed session read; shows no copy",
  "lib/buyer-auth.ts": "clears a presence cookie on a failed session read; shows no copy",
  "lib/customer-not-linked.ts":
    "classifies the GET /orders 403 for a login with no customer record (a read)",
  "lib/scan-po-lock.ts":
    "classifies the PLAN_GATE 403 on the scan route; a plan lock, not a write copy",
  "app/(platform-admin)/admin/tenants/[id]/_features/profile-errors.ts":
    "platform-admin console: a platform admin is not a tenant workspace, so READ_ONLY (tenant status) never applies",
};

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:])\/\/.*$/gm, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(WEB_ROOT, file).split(path.sep).join("/");

function candidates(): string[] {
  const lib = fs
    .readdirSync(path.join(WEB_ROOT, "lib"), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => path.join(WEB_ROOT, "lib", e.name));
  const copyFiles = ["app", "components"].flatMap((d) =>
    walk(path.join(WEB_ROOT, d)).filter((f) => COPY_FILE.test(path.basename(f))),
  );
  return [...lib, ...copyFiles].filter((f) => !TEST_FILE.test(f));
}

const BRANCHES_ON_PERMISSION = /\b(401|403)\b|forbidden/i;
const KNOWS_READ_ONLY = /READ_ONLY|isReadOnlyRefusal|readOnlyRefusalCopy/;

describe("READ_ONLY copy pin: a 401 / 403 fallback never wins over the read-only refusal", () => {
  const files = candidates();

  it("scans the copy files we know about (the scan is not silently empty)", () => {
    const names = files.map(rel);
    expect(names).toEqual(
      expect.arrayContaining([
        "lib/counter-sale.ts",
        "lib/reason-copy.ts",
        "lib/generic-toast-copy.ts",
        "lib/customer-form-error-copy.ts",
        "app/(dashboard)/returns/_components/refund-copy.ts",
      ]),
    );
  });

  it("every file with a 401 / 403 / forbidden branch also knows READ_ONLY, or is allow-listed", () => {
    const offenders = files
      .filter((f) => BRANCHES_ON_PERMISSION.test(stripComments(fs.readFileSync(f, "utf8"))))
      .filter((f) => !KNOWS_READ_ONLY.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map(rel)
      .filter((name) => !(name in NEVER_SEES_WRITE_REFUSALS));
    expect(offenders).toEqual([]);
  });

  it("the allow-list holds no stale entry (the file exists and still has a 401 / 403 / forbidden branch)", () => {
    for (const name of Object.keys(NEVER_SEES_WRITE_REFUSALS)) {
      const full = path.join(WEB_ROOT, name);
      expect(fs.existsSync(full)).toBe(true);
      const src = stripComments(fs.readFileSync(full, "utf8"));
      expect(BRANCHES_ON_PERMISSION.test(src)).toBe(true);
      expect(KNOWS_READ_ONLY.test(src)).toBe(false); // once it knows READ_ONLY, drop the entry
      expect(NEVER_SEES_WRITE_REFUSALS[name].length).toBeGreaterThan(10);
    }
  });
});
