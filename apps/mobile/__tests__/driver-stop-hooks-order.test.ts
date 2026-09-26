import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

/**
 * #2257 (P1): the mobile-web driver STOP SCREEN crashed with React #310 ("Rendered more hooks
 * than during the previous render"). `useMemo(() => itemsFromStop(stop))` sat AFTER the
 * `if (activeLoading || runLoading) return …` and `if (!stop) return …` early returns, so the
 * loading render ran N hooks and the loaded render N+1.
 *
 * The render-toggle this guards: loading (early return) → loaded (full render) must call the
 * SAME hooks. This jest lane runs in plain node and cannot mount an RN screen, so the pin
 * checks the rule that makes the toggle safe, on the real source via the TypeScript AST: no
 * hook call at the component's top level after its first early return. (ESLint's
 * react-hooks/rules-of-hooks is an ERROR for mobile now too — see eslint.config.mjs.)
 */
const FILE = join(__dirname, "..", "app/(driver)/route/stop/[stopId]/index.tsx");

function hookCallsAfterFirstEarlyReturn(source: string, component: string): string[] {
  const sf = ts.createSourceFile(FILE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === component,
  );
  if (!fn?.body) throw new Error(`${component} not found`);

  const returns = (n: ts.Node): boolean =>
    ts.isReturnStatement(n) || (!ts.isFunctionLike(n) && ts.forEachChild(n, returns) === true);
  const isHook = (e: ts.Expression) =>
    (ts.isIdentifier(e) && /^use[A-Z]/.test(e.text)) ||
    (ts.isPropertyAccessExpression(e) && /^use[A-Z]/.test(e.name.text));

  const found: string[] = [];
  const collect = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return; // callbacks declared here don't run during render
    if (ts.isCallExpression(n) && isHook(n.expression)) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
      found.push(`${n.expression.getText()} @ line ${line + 1}`);
    }
    ts.forEachChild(n, collect);
  };

  let afterReturn = false;
  for (const stmt of fn.body.statements) {
    if (afterReturn) collect(stmt);
    else if (ts.isIfStatement(stmt) && returns(stmt)) afterReturn = true;
  }
  return found;
}

describe("driver stop screen: hooks never follow an early return (#2257, React #310)", () => {
  const src = readFileSync(FILE, "utf8");

  it("StopDetailScreen calls every hook before its first early return", () => {
    expect(hookCallsAfterFirstEarlyReturn(src, "StopDetailScreen")).toEqual([]);
  });

  it("the checker itself catches a hook after an early return", () => {
    const bad = `function StopDetailScreen() {
      const a = useA();
      if (!a) { return null; }
      const b = React.useMemo(() => 1, []);
      const cb = () => useNotDuringRender();
      return b;
    }`;
    expect(hookCallsAfterFirstEarlyReturn(bad, "StopDetailScreen")).toEqual([
      "React.useMemo @ line 4",
    ]);
  });
});
