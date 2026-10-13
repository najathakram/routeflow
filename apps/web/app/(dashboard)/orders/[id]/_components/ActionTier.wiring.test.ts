import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Which existing action lands in which tier on the order-detail page (T7).
 *
 * `ActionTier.test.tsx` covers the wrapper, but nothing renders `OrderDetailPage` (it needs ~40
 * hooks), so a mis-wrapped button — Cancel in the primary tier, Publish in danger, a tier dropped
 * entirely — would pass every other test. This parses the page with the TypeScript compiler and
 * reads the STRUCTURE (which <Button> labels sit inside which <ActionTier tier=…>), not raw text.
 * It is deliberately a structural pin: adding or renaming an action must update the table below.
 */

// The page plus the action groups it delegates to (ConfirmedPrimaryAction / OutForDeliveryPrimary live beside PosOrderActions).
const FILES = [
  path.resolve(__dirname, "../page.tsx"),
  path.resolve(__dirname, "./PosOrderActions.tsx"),
  path.resolve(__dirname, "./DeleteOrderTier.tsx"),
];
const sources = FILES.map((f) =>
  ts.createSourceFile(
    f,
    fs.readFileSync(f, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ),
);

interface Found {
  tier: string;
  buttons: string[];
  deleteCalls: number;
}

/** String literals + plain JSX text directly inside a <Button>'s children. */
function labelsOf(button: ts.JsxElement): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const t = n.getText().replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      // A literal compared with `===` is a condition (`fulfillPath === "SHIP"`), not a label.
      const isComparison =
        ts.isBinaryExpression(n.parent) &&
        n.parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
      if (!isComparison) out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  button.children.forEach(visit);
  return out;
}

function tierName(el: ts.JsxOpeningLikeElement): string | null {
  const attr = el.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "tier",
  );
  return attr && attr.initializer && ts.isStringLiteral(attr.initializer)
    ? attr.initializer.text
    : null;
}

function collect(): Found[] {
  const found: Found[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n) && n.openingElement.tagName.getText() === "ActionTier") {
      const tier = tierName(n.openingElement);
      // A tier chosen at runtime (`tier={…}`) lives in a delegated component, not in the page's own wiring.
      if (tier === null && n.getSourceFile() !== sources[0]) return ts.forEachChild(n, visit);
      const buttons: string[] = [];
      let deleteCalls = 0;
      const inner = (c: ts.Node) => {
        if (
          ts.isJsxElement(c) &&
          ["Button", "WriteButton"].includes(c.openingElement.tagName.getText())
        ) {
          buttons.push(...labelsOf(c));
        }
        // <CancelOrderButton> IS the "Cancel Order" button (or, when the server blocks the cancel, its note)
        if (ts.isJsxSelfClosingElement(c) && c.tagName.getText() === "CancelOrderButton") {
          buttons.push("Cancel Order");
        }
        if (ts.isCallExpression(c) && c.expression.getText() === "renderDeleteOrderAction") {
          deleteCalls += 1;
        }
        ts.forEachChild(c, inner);
      };
      n.children.forEach(inner);
      found.push({ tier: tier ?? "?", buttons, deleteCalls });
    }
    if (ts.isJsxSelfClosingElement(n) && n.tagName.getText() === "DeleteOrderTier") {
      // DeleteOrderTier renders its own danger tier; its idle button label is the `idleLabel` prop.
      const attr = n.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === "idleLabel",
      );
      const init = attr?.initializer;
      if (init && ts.isStringLiteral(init)) {
        found.push({ tier: "danger", buttons: [init.text], deleteCalls: 0 });
      }
    }
    ts.forEachChild(n, visit);
  };
  sources.forEach((src) => visit(src));
  return found;
}

const found = collect();
const byTier = (tier: string) => found.filter((f) => f.tier === tier);
const labels = (tier: string) => new Set(byTier(tier).flatMap((f) => f.buttons));

describe("order-detail action bar tiers (page wiring)", () => {
  it("finds the wrapped groups (a sanity floor: the parse must be able to fail)", () => {
    expect(found.length).toBeGreaterThanOrEqual(15);
    expect(found.every((f) => ["primary", "secondary", "danger"].includes(f.tier))).toBe(true);
  });

  it("PRIMARY holds only the actions that advance the order", () => {
    expect(labels("primary")).toEqual(
      new Set([
        "Publish Order",
        "Confirm Order",
        "Mark shipped",
        "Out for Delivery",
        "Ready for pickup",
        "Mark delivered",
        "Mark as Delivered",
      ]),
    );
  });

  it("SECONDARY holds only reversible, non-destructive actions", () => {
    expect(labels("secondary")).toEqual(
      new Set([
        "Edit Items",
        "Edit order", // the POS-mode label of the same button
        "Unconfirm",
        "Unmark shipped",
        "Return to Confirmed",
        "Reopen Order",
      ]),
    );
  });

  it("DANGER holds only Cancel / Delete — and every Cancel and Delete is in it", () => {
    expect(labels("danger")).toEqual(
      new Set(["Cancel Order", "Delete Draft", "Delete", "Confirm Delete"]),
    );
    // no destructive label leaks into another tier
    for (const tier of ["primary", "secondary"]) {
      for (const l of labels(tier)) expect(l).not.toMatch(/^(Cancel|Delete|Confirm Delete)/);
    }
    // the shared Delete-order action (renderDeleteOrderAction) only ever appears in a danger tier
    for (const tier of ["primary", "secondary"]) {
      expect(byTier(tier).reduce((n, f) => n + f.deleteCalls, 0)).toBe(0);
    }
    expect(byTier("danger").reduce((n, f) => n + f.deleteCalls, 0)).toBeGreaterThanOrEqual(3);
  });

  it("no advance or reversible action sits in the danger tier", () => {
    for (const l of [
      "Publish Order",
      "Confirm Order",
      "Out for Delivery",
      "Mark as Delivered",
      "Unconfirm",
      "Return to Confirmed",
      "Reopen Order",
      "Edit Items",
    ]) {
      expect(labels("danger").has(l)).toBe(false);
    }
  });
});
