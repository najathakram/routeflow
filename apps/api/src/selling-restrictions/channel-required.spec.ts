/**
 * Lane R — static guard: every caller of the selling-restrictions choke point states its CHANNEL.
 *
 * `restrictionChannelForRole` keyed off `role`, which a buyer-portal principal does not carry, so
 * a BUYER_PORTAL ban did not bind the buyer (P1). Omitting the channel was the same hole (it used
 * to default to STAFF). The service now fails closed, and this walks the tree so a NEW caller that
 * omits `channel` — or hand-rolls it from a role — fails here instead of exempting a channel in
 * production.
 *
 * Checked for every non-spec call of `assertLinesSellable` / `checkLinesSellable` (the params
 * object) and of `evaluate` on a restrictions receiver (the 4th argument, the options object):
 *   - the argument is an object literal that carries a `channel` property (a spread or a variable
 *     cannot be verified, so it fails);
 *   - its value is `restrictionChannelForPrincipal(...)`, an explicit `"STAFF"` / `"BUYER_PORTAL"`
 *     literal (a cron / system caller), or an identifier initialised from the helper in the same
 *     file — never a hand-rolled `role === "CUSTOMER" ? …`.
 * Excluded: `*.spec.ts`, and the service itself (it is the definition: its own delegating calls
 * are typed by the required `channel`).
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "..");
const SERVICE = path.join(SRC_ROOT, "selling-restrictions", "selling-restrictions.service.ts");
const HELPER = "restrictionChannelForPrincipal";
const CHOKE_POINT = new Set(["assertLinesSellable", "checkLinesSellable"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") collectSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isChannelLiteral = (e: ts.Expression) =>
  (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) &&
  (e.text === "STAFF" || e.text === "BUYER_PORTAL");

/** Names initialised from the helper anywhere in the file: `const channel = restrictionChannel…(…)`. */
function helperBoundNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sf, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf).endsWith(HELPER)
    )
      names.add(n.name.text);
  });
  return names;
}

function channelProblem(arg: ts.Expression | undefined, sf: ts.SourceFile, bound: Set<string>) {
  if (!arg || !ts.isObjectLiteralExpression(arg))
    return "the argument is missing or not an object literal (a spread / variable cannot be checked)";
  const prop = arg.properties.find(
    (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name.getText(sf) === "channel",
  );
  if (!prop) return "no `channel` property (an omitted channel must never mean STAFF)";
  const value = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
  if (isChannelLiteral(value)) return null;
  if (ts.isCallExpression(value) && value.expression.getText(sf).endsWith(HELPER)) return null;
  if (ts.isIdentifier(value) && bound.has(value.text)) return null;
  return `channel must be ${HELPER}(principal) or a "STAFF" / "BUYER_PORTAL" literal, not \`${value.getText(sf)}\``;
}

/** Every violation in one source text: the self-test feeds it snippets, the walk feeds it real files. */
function channelViolations(text: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const bound = helperBoundNames(sf);
  const out: string[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const name = n.expression.name.text;
    const receiver = n.expression.expression.getText(sf);
    let arg: ts.Expression | undefined;
    if (CHOKE_POINT.has(name)) arg = n.arguments[0];
    else if (name === "evaluate" && /restrictions/i.test(receiver)) arg = n.arguments[3];
    else return;
    const problem = channelProblem(arg, sf, bound);
    if (problem) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      out.push(`${fileName}:${line + 1} ${receiver}.${name}(…): ${problem}`);
    }
  });
  return out;
}

describe("every selling-restrictions call site states its channel", () => {
  const FILES = collectSourceFiles(SRC_ROOT).filter((f) => f !== SERVICE);

  it("walks a non-trivial number of source files and the choke point still exists under the names scanned for (an empty or renamed scan must not report green)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    const service = fs.readFileSync(SERVICE, "utf8");
    for (const method of [...CHOKE_POINT, "evaluate"])
      expect(service).toMatch(new RegExp(`async ${method}\\(`));
    expect(
      fs.readFileSync(
        path.join(SRC_ROOT, "selling-restrictions", "selling-restrictions.core.ts"),
        "utf8",
      ),
    ).toMatch(new RegExp(`export function ${HELPER}\\(`));
  });

  it("no production caller omits `channel` or hand-rolls it", () => {
    const violations = FILES.flatMap((file) =>
      channelViolations(fs.readFileSync(file, "utf8"), path.relative(SRC_ROOT, file)),
    );
    expect(violations).toEqual([]);
  });

  describe("the detector itself can fail", () => {
    const assertCall = (arg: string) => `this.restrictions.assertLinesSellable(${arg});`;

    it.each([
      ["no channel", assertCall("{ tenantId, customerId, lines }")],
      ["a spread", assertCall("{ ...params }")],
      ["a variable", assertCall("params")],
      [
        "a hand-rolled role check",
        assertCall(
          '{ tenantId, lines, channel: user.role === "CUSTOMER" ? "BUYER_PORTAL" : "STAFF" }',
        ),
      ],
      ["an unbound identifier", assertCall("{ tenantId, lines, channel }")],
      ["checkLinesSellable too", "this.restrictions.checkLinesSellable({ tenantId, lines });"],
      ["evaluate without options", "this.restrictions.evaluate(t, c, lines);"],
      ["evaluate options without channel", "this.restrictions.evaluate(t, c, lines, { at });"],
    ])("flags %s", (_label, text) => {
      expect(channelViolations(text)).toHaveLength(1);
    });

    it.each([
      [
        "the helper",
        assertCall("{ tenantId, lines, channel: restrictionChannelForPrincipal(user) }"),
      ],
      ["a STAFF literal (cron / system)", assertCall('{ tenantId, lines, channel: "STAFF" }')],
      ["a BUYER_PORTAL literal", assertCall('{ tenantId, lines, channel: "BUYER_PORTAL" }')],
      [
        "an identifier initialised from the helper",
        `const channel = restrictionChannelForPrincipal(user); ${assertCall("{ tenantId, lines, channel }")}`,
      ],
      [
        "evaluate with a channel",
        'this.restrictions.evaluate(t, c, lines, { channel: "STAFF", at });',
      ],
      [
        "an unrelated evaluate (route optimisation)",
        "const v = evaluate(stops); this.planner.evaluate(x);",
      ],
    ])("accepts %s", (_label, text) => {
      expect(channelViolations(text)).toEqual([]);
    });
  });
});
