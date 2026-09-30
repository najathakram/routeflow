/**
 * #2775 (SA-599): Google and Apple sign-in share ONE resolve-then-link rule
 * (`oauth-account-link.ts`). These source pins fail if a provider service grows its own private
 * copy again, or if any other file defines a second one.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const AUTH_DIR = __dirname;
const SRC_DIR = join(__dirname, "..");
const SERVICES = ["google-oauth.service.ts", "apple-oauth.service.ts"];

const PRIVATE_HELPER_RE = /private\s+async\s+(resolveBySubThenEmail|casLink\w*)/;
const HELPER_DEF_RE =
  /(?:\bfunction\s+|\b(?:private|public|protected)\s+(?:async\s+)?|^\s*async\s+)(?:resolveBySubThenEmail|casLinkGoogleId|casLinkAppleId)\b/m;

function read(file: string): string {
  return readFileSync(join(AUTH_DIR, file), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("oauth providers use the shared link helper only (#2775 / SA-599)", () => {
  it.each(SERVICES)("%s declares no private resolve/casLink method", (file) => {
    expect(read(file)).not.toMatch(PRIVATE_HELPER_RE);
  });

  it.each(SERVICES)("%s imports and calls the shared helpers", (file) => {
    const src = read(file);
    expect(src).toMatch(/from\s+"\.\/oauth-account-link"/);
    expect(src).toMatch(/[^.\w]resolveBySubThenEmail\(/);
    expect(src).toMatch(/[^.\w]casLinkProviderId\(/);
    expect(src).not.toMatch(/this\.(resolveBySubThenEmail|casLink\w*)\(/);
  });

  it("no other non-spec file in apps/api/src defines a link helper of its own", () => {
    const offenders = walk(SRC_DIR)
      .filter((f) => !f.endsWith(".spec.ts") && !f.endsWith("oauth-account-link.ts"))
      .filter((f) => HELPER_DEF_RE.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the patterns are discriminating: they see a planted private method and definition", () => {
    const planted = `class X {\n  private async resolveBySubThenEmail<T>(a: T) {}\n  private async casLinkGoogleId(x) {}\n}`;
    expect(planted).toMatch(PRIVATE_HELPER_RE);
    expect(`private async casLinkAppleId(x) {}`).toMatch(PRIVATE_HELPER_RE);
    expect(planted).toMatch(HELPER_DEF_RE);
    expect(`export function casLinkAppleId(a: string): void {`).toMatch(HELPER_DEF_RE);
    // ...and does not flag a call site
    expect(`const r = await resolveBySubThenEmail({ column: "googleId" });`).not.toMatch(
      HELPER_DEF_RE,
    );
  });
});
