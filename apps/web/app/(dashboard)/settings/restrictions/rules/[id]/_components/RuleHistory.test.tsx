import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import type { RuleDetailDto } from "@routeflow/types";
import { RuleHistory } from "./RuleHistory";

const AT = "2026-10-05T12:00:00Z";
const rev = (revision: number, by: string, at = AT) => ({
  revision,
  jurisdiction: "STATE" as const,
  states: ["TX"],
  surface: "ALL" as const,
  effectiveFrom: AT,
  effectiveTo: null,
  reason: "r",
  editedByName: by,
  editedAt: at,
  note: null,
});
const evt = (kind: "ADDED" | "REMOVED", count: number, at = AT) => ({
  kind,
  count,
  byName: "Pat",
  at,
  reason: null,
});
const order = (revisions: RuleDetailDto["revisions"], events: RuleDetailDto["targetEvents"]) => {
  const { unmount } = render(<RuleHistory revisions={revisions} events={events} />);
  const texts = within(screen.getByRole("list", { name: "History" }))
    .getAllByRole("listitem")
    .map((l) => l.textContent?.split(" · ")[0]);
  unmount();
  return texts;
};

describe("RuleHistory", () => {
  it("newest first", () => {
    expect(
      order(
        [rev(1, "Pat", "2026-03-04T12:00:00Z")],
        [evt("ADDED", 2, "2026-10-01T12:00:00Z"), evt("REMOVED", 1, "2026-10-02T12:00:00Z")],
      ),
    ).toEqual(["1 removed by Pat", "2 added by Pat", "Rule created by Pat"]);
  });

  it("entries with the same timestamp keep a fixed order: revision desc, then kind", () => {
    const revisions = [rev(2, "Sam"), rev(3, "Sam")];
    const events = [evt("REMOVED", 1), evt("ADDED", 4)];
    const expected = [
      "Settings changed by Sam", // revision 3
      "Settings changed by Sam", // revision 2
      "4 added by Pat",
      "1 removed by Pat",
    ];
    expect(order(revisions, events)).toEqual(expected);
    // the input order does not matter
    expect(order([...revisions].reverse(), [...events].reverse())).toEqual(expected);
  });

  it("revision 3 lists before revision 2 even though the API sent them oldest first", () => {
    const { container } = render(
      <RuleHistory
        revisions={[
          { ...rev(2, "Sam"), note: "second" },
          { ...rev(3, "Sam"), note: "third" },
        ]}
        events={[]}
      />,
    );
    const notes = Array.from(container.querySelectorAll("li p:nth-of-type(2)")).map(
      (p) => p.textContent,
    );
    expect(notes).toEqual(["third", "second"]);
  });
});
