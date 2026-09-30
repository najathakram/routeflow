import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { UserRole } from "@prisma/client";
import { restrictionChannelForPrincipal } from "../selling-restrictions/selling-restrictions.core";
import { makePseudoUser } from "./buyer.controller";

/**
 * P1 residual: `makePseudoUser` stamped no `type`, so the buyer routes that pass `role: OPERATOR`
 * (to skip a userId lookup) resolved to the STAFF selling-restrictions channel — a BUYER_PORTAL ban
 * would not bind a buyer reading through them. Every pseudo-user built for a buyer's request now
 * carries `type: "BUYER"`, which `restrictionChannelForPrincipal` reads before the role.
 */
const ctx = { userId: "u-1", tenantId: "t-1", tenantSlug: "acme" };

describe("makePseudoUser — the buyer's request is always the BUYER_PORTAL channel", () => {
  it.each([undefined, UserRole.CUSTOMER, UserRole.OPERATOR])(
    "role %s: stamped type BUYER, channel BUYER_PORTAL",
    (role) => {
      const user = makePseudoUser({ ...ctx, role });
      expect(user.type).toBe("BUYER");
      expect(restrictionChannelForPrincipal(user)).toBe("BUYER_PORTAL");
    },
  );

  it("the role override still reaches the service (the OPERATOR routes still skip the userId lookup)", () => {
    expect(makePseudoUser({ ...ctx, role: UserRole.OPERATOR }).role).toBe(UserRole.OPERATOR);
    expect(makePseudoUser(ctx).role).toBe(UserRole.CUSTOMER);
  });

  it("a real staff principal (no type) is still STAFF — the stamp is not a blanket", () => {
    expect(restrictionChannelForPrincipal({ role: UserRole.OPERATOR })).toBe("STAFF");
  });
});

// ─── every pseudo-user literal in the tree is stamped (the scan can fail: proven on inline source) ──
function unstampedPseudoUsers(text: string, fileName = "x.ts"): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      const named = (k: string) =>
        n.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === k) as
          | ts.PropertyAssignment
          | undefined;
      const username = named("username")?.initializer;
      const isPseudo = !!username && ts.isStringLiteral(username) && username.text === "";
      let type = named("type")?.initializer;
      // `"BUYER" as const` is the same stamp
      while (type && (ts.isAsExpression(type) || ts.isSatisfiesExpression(type)))
        type = type.expression;
      if (isPseudo && !(type && ts.isStringLiteral(type) && type.text === "BUYER"))
        out.push(`${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("every JwtPayload pseudo-user literal (username: '') carries type BUYER", () => {
  const SRC = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
            ? [path.join(dir, e.name)]
            : [],
      );

  it("detector: flags an unstamped pseudo-user, accepts a stamped one, ignores a real payload", () => {
    expect(
      unstampedPseudoUsers('const p = { sub: "a", username: "", role: "CUSTOMER" };'),
    ).toHaveLength(1);
    expect(
      unstampedPseudoUsers('const p = { sub: "a", username: "", type: "OTHER" };'),
    ).toHaveLength(1);
    expect(unstampedPseudoUsers('const p = { sub: "a", username: "", type: "BUYER" };')).toEqual(
      [],
    );
    expect(
      unstampedPseudoUsers('const p = { sub: "a", username: "", type: "BUYER" as const };'),
    ).toEqual([]);
    expect(unstampedPseudoUsers('const p = { sub: "a", username: user.username };')).toEqual([]);
  });

  it("no production source builds an unstamped pseudo-user, and the scan really finds the two known sites", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(300);
    const violations = files.flatMap((f) =>
      unstampedPseudoUsers(fs.readFileSync(f, "utf8"), path.relative(SRC, f)),
    );
    expect(violations).toEqual([]);
    const total = files.filter((f) => /username: ""/.test(fs.readFileSync(f, "utf8"))).length;
    expect(total).toBeGreaterThanOrEqual(2); // buyer.controller.ts + change-requests.service.ts
  });
});
