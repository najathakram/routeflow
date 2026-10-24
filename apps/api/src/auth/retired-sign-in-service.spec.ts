/**
 * Static guard: the retired per-tenant Google sign-in service stays deleted.
 *
 * The legacy per-tenant Google sign-in routes answer 410 (SIGN_IN_ROUTE_RETIRED). The service
 * behind them did find-or-create sign-in with no CSRF state and no suspended/locked checks, so it
 * must not come back as an injectable a new route could pick up. Two checks, both static (no DB,
 * no Nest boot):
 *
 * 1. No file under `apps/api/src` (specs included, this one excluded) names the retired class or
 *    its file.
 * 2. No `@Controller` class constructor injects a provider from the retired set, by type
 *    annotation or by `@Inject(Token)`.
 *
 * A new Google sign-in path must go through GoogleOAuthService's signed state + nonce flow
 * (`apps/api/src/auth/google-oauth.service.ts`), never a per-tenant shortcut.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "..");
const THIS_FILE = path.resolve(__filename);

/** Provider class names that must never be injected into a controller again. */
const RETIRED_SIGN_IN_PROVIDERS = new Set(["TenantGoogleOAuthService"]);
const RETIRED_FILE_STEM = "tenant-google-oauth.service";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (entry.name.endsWith(".ts") && full !== THIS_FILE) out.push(full);
  }
  return out;
}

function decoratorName(d: ts.Decorator): string | undefined {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  if (ts.isIdentifier(e)) return e.text;
  return undefined;
}

/** `ClassName -> injected provider names` for every `@Controller` class in one source text. */
export function controllerInjections(text: string): Map<string, string[]> {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const result = new Map<string, string[]>();
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n)) {
      const isController = (ts.getDecorators(n) ?? []).some(
        (d) => decoratorName(d) === "Controller",
      );
      if (isController) {
        const names: string[] = [];
        for (const member of n.members) {
          if (!ts.isConstructorDeclaration(member)) continue;
          for (const p of member.parameters) {
            if (p.type && ts.isTypeReferenceNode(p.type) && ts.isIdentifier(p.type.typeName))
              names.push(p.type.typeName.text);
            for (const d of ts.getDecorators(p) ?? []) {
              const e = d.expression;
              if (
                ts.isCallExpression(e) &&
                decoratorName(d) === "Inject" &&
                e.arguments.length > 0 &&
                ts.isIdentifier(e.arguments[0])
              )
                names.push(e.arguments[0].text);
            }
          }
        }
        result.set(n.name?.text ?? "<anonymous>", names);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return result;
}

describe("retired per-tenant Google sign-in service", () => {
  const files = walk(SRC_ROOT);
  const sources = files.filter((f) => !f.endsWith(".spec.ts"));

  it("walks a non-trivial tree (an empty or renamed scan must not report green)", () => {
    expect(sources.length).toBeGreaterThan(300);
  });

  it("no file under apps/api/src names the retired service or its file", () => {
    const pattern = new RegExp(
      [...RETIRED_SIGN_IN_PROVIDERS, RETIRED_FILE_STEM]
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
    );
    const hits = files
      .filter((f) => pattern.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC_ROOT, f));
    expect(hits).toEqual([]);
  });

  it("the controller scan detects an injection by type and by @Inject token", () => {
    const fixture = [
      "@Controller('x') class A { constructor(private readonly s: TenantGoogleOAuthService) {} }",
      "@Controller() class B { constructor(@Inject(TenantGoogleOAuthService) s: unknown) {} }",
      "class C { constructor(private readonly s: TenantGoogleOAuthService) {} }",
    ].join("\n");
    const found = controllerInjections(fixture);
    expect(found.get("A")).toEqual(["TenantGoogleOAuthService"]);
    expect(found.get("B")).toEqual(["TenantGoogleOAuthService"]);
    expect(found.has("C")).toBe(false);
  });

  it("no controller constructor injects a retired sign-in provider", () => {
    let controllers = 0;
    const violations: string[] = [];
    for (const f of sources) {
      for (const [cls, names] of controllerInjections(fs.readFileSync(f, "utf8"))) {
        controllers += 1;
        for (const n of names)
          if (RETIRED_SIGN_IN_PROVIDERS.has(n))
            violations.push(`${path.relative(SRC_ROOT, f)} ${cls} injects ${n}`);
      }
    }
    expect(controllers).toBeGreaterThan(30);
    expect(violations).toEqual([]);
  });
});
