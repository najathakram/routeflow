import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, screen } from "@testing-library/react";
import { RestrictionOverrideNote } from "./RestrictionOverrideNote";
import { restrictionOverrideLine } from "@/lib/restriction-override-note";

const stamp = {
  restrictionOverrideReason: "Owner approved the sale",
  restrictionOverrideBy: "u-1",
  restrictionOverrideAt: "2026-10-07T15:14:00.000Z",
  restrictionOverrideRuleIds: ["r1"],
};
describe("restrictionOverrideLine (pure)", () => {
  it("reads 'Sold despite restriction · reason · by name · date'", () => {
    expect(
      restrictionOverrideLine({
        reason: "Owner approved",
        name: "pat",
        at: "2026-10-07T15:14:00.000Z",
      }),
    ).toBe("Sold despite restriction · Owner approved · by pat · Oct 7, 2026");
  });
  it("falls back to 'former user' when the name can't be resolved", () => {
    expect(restrictionOverrideLine({ reason: "Owner approved", name: null, at: null })).toBe(
      "Sold despite restriction · Owner approved · by former user",
    );
  });
});

describe("RestrictionOverrideNote", () => {
  it("renders nothing on a line with no override", () => {
    const { container } = render(
      <RestrictionOverrideNote
        line={{ restrictionOverrideReason: null, restrictionOverrideRuleIds: [] }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    const r2 = render(<RestrictionOverrideNote line={{}} />);
    expect(r2.container).toBeEmptyDOMElement();
  });

  it("shows the reason, the name the API resolved and the date", () => {
    render(<RestrictionOverrideNote line={{ ...stamp, restrictionOverrideByName: "Pat R" }} />);
    expect(screen.getByTestId("restriction-override-note")).toHaveTextContent(
      "Sold despite restriction · Owner approved the sale · by Pat R · Oct 7, 2026",
    );
  });

  it("says 'former user' ONLY when the API sent a null name (the user is gone)", () => {
    render(<RestrictionOverrideNote line={{ ...stamp, restrictionOverrideByName: null }} />);
    expect(screen.getByTestId("restriction-override-note")).toHaveTextContent("by former user");
  });

  it("an absent name field never claims 'former user' (older API): the by part is left out", () => {
    render(<RestrictionOverrideNote line={stamp} />);
    const text = screen.getByTestId("restriction-override-note").textContent;
    expect(text).not.toMatch(/former user|by /);
  });
});

describe("staff only", () => {
  const WEB = path.resolve(__dirname, "..");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
  };
  it("the note fetches nothing: no /users call (user management is admin-only, an operator would get a false 'former user')", () => {
    for (const f of [
      "components/RestrictionOverrideNote.tsx",
      "lib/restriction-override-note.ts",
    ]) {
      const src = fs.readFileSync(path.join(WEB, f), "utf8");
      expect(src).not.toMatch(/\/users|apiClient|useQuery|api-client/);
    }
  });
  it("no buyer-portal source mentions the note or an override column", () => {
    for (const p of walk(path.join(WEB, "app/buyer"))) {
      expect(fs.readFileSync(p, "utf8")).not.toMatch(/RestrictionOverrideNote|restrictionOverride/);
    }
  });
  it("the shared read-only line row (also used by the buyer portal) never reads the stamp", () => {
    const src = fs.readFileSync(path.join(WEB, "components/LineItemRowReadOnly.tsx"), "utf8");
    expect(src).not.toMatch(/restrictionOverride|RestrictionOverrideNote/);
  });
  it("the staff order and invoice detail rows render the note", () => {
    const read = (f: string) => fs.readFileSync(path.join(WEB, f), "utf8");
    expect(read("app/(dashboard)/orders/[id]/_components/OrderLineItemsTable.tsx")).toContain(
      "RestrictionOverrideNote",
    );
    expect(read("app/(dashboard)/orders/[id]/_components/OrderLineItemCards.tsx")).toContain(
      "RestrictionOverrideNote",
    );
    expect(read("app/(dashboard)/invoices/[id]/page.tsx")).toContain("RestrictionOverrideNote");
  });
});
