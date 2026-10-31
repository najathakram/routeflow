import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * Static discovery of every controller handler and the access it carries (spec-operator-permissions §4.4). It reads the
 * TypeScript AST (a comment or a string never counts), so the coverage spec needs no Nest bootstrap and loads no service.
 */
export type Access =
  | { kind: "GROUPS"; groups: string[] }
  | { kind: "BASE" }
  | { kind: "ADMIN" }
  | { kind: "UNGUARDED" };

export interface Handler {
  /** "Controller.method" - the key the pinned map uses. */
  key: string;
  file: string;
  roles: string[] | null;
  /** The permission decoration that applies (method overrides class), null when none. */
  permission: { kind: "GROUPS"; groups: string[] } | { kind: "BASE"; reason: string } | null;
  /** Whether the permission decoration comes from the class (true) or the method (false). */
  permissionFromClass: boolean;
}

const HTTP = new Set(["Get", "Post", "Put", "Patch", "Delete", "All", "Head", "Options"]);
const decoName = (d: ts.Decorator): string => {
  const e = d.expression;
  return ts.isCallExpression(e) ? e.expression.getText() : e.getText();
};
const decoArgs = (d: ts.Decorator): ts.Expression[] =>
  ts.isCallExpression(d.expression) ? [...d.expression.arguments] : [];

const rolesFrom = (decs: readonly ts.Decorator[]): string[] | null => {
  const r = decs.find((d) => decoName(d) === "Roles");
  return r ? decoArgs(r).map((a) => a.getText().replace(/^UserRole\./, "")) : null;
};
const permissionFrom = (decs: readonly ts.Decorator[]): Handler["permission"] => {
  for (const d of decs) {
    if (decoName(d) === "PermissionBase") {
      const arg = decoArgs(d)[0];
      return { kind: "BASE", reason: arg && ts.isStringLiteralLike(arg) ? arg.text : "" };
    }
    if (decoName(d) === "RequirePermission") {
      return {
        kind: "GROUPS",
        groups: decoArgs(d).map((a) => a.getText().replace(/^["']|["']$/g, "")),
      };
    }
  }
  return null;
};

export function handlersIn(file: string, source: string): Handler[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Handler[] = [];
  for (const cls of sf.statements.filter(ts.isClassDeclaration)) {
    const cdecs = ts.getDecorators(cls) ?? [];
    if (!cdecs.some((d) => decoName(d) === "Controller")) continue;
    const classRoles = rolesFrom(cdecs);
    const classPerm = permissionFrom(cdecs);
    for (const m of cls.members.filter(ts.isMethodDeclaration)) {
      const decs = ts.getDecorators(m) ?? [];
      if (!decs.some((d) => HTTP.has(decoName(d)))) continue;
      const methodPerm = permissionFrom(decs);
      out.push({
        key: `${cls.name?.text ?? "?"}.${m.name.getText()}`,
        file,
        roles: rolesFrom(decs) ?? classRoles,
        permission: methodPerm ?? classPerm,
        permissionFromClass: !methodPerm && !!classPerm,
      });
    }
  }
  return out;
}

export function allHandlers(srcRoot: string): Handler[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.controller\.ts$/.test(e.name) ? [p] : [];
    });
  return walk(srcRoot)
    .sort()
    .flatMap((f) =>
      handlersIn(path.relative(srcRoot, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")),
    );
}

/**
 * The pinned-map value for a handler, or null when it is never reachable by an operator or a tenant admin (a platform
 * admin, buyer, driver-only or customer-only route: "OUT", not listed).
 *   ADMIN      @Roles has TENANT_ADMIN and not OPERATOR
 *   GROUP list / BASE   @Roles admits OPERATOR
 *   UNGUARDED  no @Roles at all (JwtAuthGuard-only or public; listed so a new one shows up in review)
 */
export function accessOf(h: Handler): string | null {
  if (!h.roles || h.roles.length === 0) return "UNGUARDED";
  const admitsOperator = h.roles.includes("OPERATOR");
  const admitsAdmin = h.roles.includes("TENANT_ADMIN");
  if (admitsOperator) {
    if (!h.permission) return "UNDECORATED";
    return h.permission.kind === "BASE" ? "BASE" : h.permission.groups.join("|");
  }
  if (admitsAdmin) return "ADMIN";
  return null;
}
