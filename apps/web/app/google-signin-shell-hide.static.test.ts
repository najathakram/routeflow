import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * #2653 / SA-542 Q3 — inside the RouteFlow app shell no page may show Google sign-in (TestFlight
 * condition). The hide is html[data-shell="1"] [data-google-signin] { display: none } (app/shell.css),
 * with <html data-shell> set before paint by lib/in-shell.ts's head script. This pins, per Google
 * entry point, that the element carrying the Google onClick sits inside a [data-google-signin]
 * ancestor and that the handler bails out first thing when isInShell(); and a SWEEP makes any new
 * web file that starts Google sign-in or renders a Google mark join this list.
 */

const WEB_ROOT = path.join(__dirname, "..");

const ENTRY_POINTS: Array<{ file: string; handler: string }> = [
  { file: "app/(auth)/login/page.tsx", handler: "handleGoogleSignIn" },
  { file: "app/(auth)/admin-login/page.tsx", handler: "handleGoogleSignIn" },
  { file: "app/buyer/login/page.tsx", handler: "handleGoogleSignIn" },
  { file: "app/buyer/register/page.tsx", handler: "handleGoogleSignUp" },
  { file: "app/buyer/invite/invite-flow.tsx", handler: "handleGoogleSignIn" },
  { file: "app/(dashboard)/settings/page.tsx", handler: "handleLinkGoogle" },
  { file: "components/ReAuthProvider.tsx", handler: "onGoogle" },
];

/** Files that may mention Google sign-in without rendering an in-shell entry point. */
const NOT_ENTRY_POINTS = new Set([
  "lib/google-oauth.tsx", // the helper itself
  "app/(auth)/auth/google/callback/page.tsx", // OAuth return page: no button
  "app/(auth)/platform/auth/callback/page.tsx", // OAuth return page: no button
]);

function parse(rel: string): ts.SourceFile {
  const file = path.join(WEB_ROOT, rel);
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function hasAttr(node: ts.Node, name: string): boolean {
  const attrs = ts.isJsxElement(node)
    ? node.openingElement.attributes
    : ts.isJsxSelfClosingElement(node)
      ? node.attributes
      : undefined;
  return !!attrs?.properties.some((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** JSX elements whose onClick={handler}. */
function clickElements(sf: ts.SourceFile, handler: string): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.name.getText() === "onClick") {
      const expr =
        n.initializer && ts.isJsxExpression(n.initializer) ? n.initializer.expression : undefined;
      if (expr && ts.isIdentifier(expr) && expr.text === handler) {
        // attribute → attributes → opening/self-closing element → (element)
        let el: ts.Node = n.parent.parent;
        if (ts.isJsxOpeningElement(el)) el = el.parent;
        out.push(el);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function insideGoogleSignin(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (hasAttr(n, "data-google-signin")) return true;
  }
  return false;
}

function handlerStartsWithShellGuard(sf: ts.SourceFile, handler: string): boolean {
  let ok = false;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === handler &&
      n.initializer &&
      ts.isArrowFunction(n.initializer) &&
      ts.isBlock(n.initializer.body)
    ) {
      const first = n.initializer.body.statements[0];
      ok = !!first && /^if \(isInShell\(\)\) return;$/.test(first.getText());
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return ok;
}

describe("#2653: every Google sign-in entry point hides inside the app shell", () => {
  it.each(ENTRY_POINTS.map((e) => [e.file, e]))("%s", (_f, e) => {
    const { file, handler } = e as { file: string; handler: string };
    const sf = parse(file);
    const els = clickElements(sf, handler);
    expect(els.length).toBeGreaterThan(0);
    for (const el of els) expect(insideGoogleSignin(el)).toBe(true);
    expect(handlerStartsWithShellGuard(sf, handler)).toBe(true);
  });

  it("SWEEP: any web file that starts Google sign-in or draws a Google mark is on the list", () => {
    const listed = new Set([...ENTRY_POINTS.map((e) => e.file), ...NOT_ENTRY_POINTS]);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "e2e")
          continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          if (/startGoogleSignIn\(|<GoogleIcon\b|auth\/google\?context=/.test(src)) {
            const rel = path.relative(WEB_ROOT, full).split(path.sep).join("/");
            if (!listed.has(rel)) offenders.push(rel);
          }
        }
      }
    };
    for (const d of ["app", "components", "lib"]) walk(path.join(WEB_ROOT, d));
    expect(offenders).toEqual([]);
  });

  // Sim proof F3 (#2554): the app shell IS the installed app — never offer the PWA install.
  it.each([
    [
      "components/PwaInstallPrompt.tsx",
      /if \(installed \|\| dismissed \|\| isInShell\(\)\) return null;/,
    ],
    [
      "components/InstallAppButton.tsx",
      /if \(platform === "installed" \|\| isInShell\(\)\) return null;/,
    ],
  ])("%s renders nothing inside the shell (F3)", (rel, guard) => {
    const src = fs.readFileSync(path.join(WEB_ROOT, rel as string), "utf8");
    expect(src).toMatch(guard as RegExp);
  });

  it("InstallAppButton's server-rendered button is CSS-hidden in the shell too (no flash, F3)", () => {
    const src = fs.readFileSync(path.join(WEB_ROOT, "components", "InstallAppButton.tsx"), "utf8");
    expect(src).toMatch(/data-hide-in-shell/);
    const css = fs.readFileSync(path.join(WEB_ROOT, "app", "shell.css"), "utf8");
    expect(css).toMatch(/html\[data-shell="1"\] \[data-hide-in-shell\]/);
  });

  it("the layout runs the shell mark in <head> and loads shell.css; shell.css hides the blocks", () => {
    const layout = fs.readFileSync(path.join(WEB_ROOT, "app", "layout.tsx"), "utf8");
    expect(layout).toMatch(/import "\.\/shell\.css";/);
    expect(layout).toMatch(/<head>[\s\S]*__html: SHELL_MARK_SCRIPT[\s\S]*<\/head>/);
    expect(layout).toMatch(/<html lang="en" suppressHydrationWarning>/);
    const css = fs.readFileSync(path.join(WEB_ROOT, "app", "shell.css"), "utf8");
    expect(css).toMatch(
      /html\[data-shell="1"\] \[data-google-signin\][^{]*\{\s*display:\s*none !important;/,
    );
  });
});
