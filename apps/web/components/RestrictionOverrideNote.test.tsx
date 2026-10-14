import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RestrictionOverrideNote } from "./RestrictionOverrideNote";
import { restrictionOverrideLine } from "@/lib/restriction-override-note";

const get = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const stamp = {
  restrictionOverrideReason: "Owner approved the sale",
  restrictionOverrideBy: "u-1",
  restrictionOverrideAt: "2026-10-07T15:14:00.000Z",
  restrictionOverrideRuleIds: ["r1"],
};
const withClient = (ui: React.ReactElement) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

beforeEach(() => jest.clearAllMocks());

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

  it("shows the reason, the resolved name and the date", async () => {
    get.mockResolvedValue({ data: { id: "u-1", username: "pat" } });
    render(withClient(<RestrictionOverrideNote line={stamp} />));
    expect(await screen.findByText(/by pat/)).toBeInTheDocument();
    expect(screen.getByTestId("restriction-override-note")).toHaveTextContent(
      "Sold despite restriction · Owner approved the sale · by pat · Oct 7, 2026",
    );
    expect(get).toHaveBeenCalledWith("/users/u-1");
  });

  it("says 'former user' when the user no longer exists", async () => {
    get.mockRejectedValue({ response: { status: 404 } });
    render(withClient(<RestrictionOverrideNote line={stamp} />));
    await waitFor(() =>
      expect(screen.getByTestId("restriction-override-note")).toHaveTextContent("by former user"),
    );
  });

  it("prefers a name the API already resolved (no lookup)", () => {
    render(
      withClient(
        <RestrictionOverrideNote line={{ ...stamp, restrictionOverrideByName: "Pat R" }} />,
      ),
    );
    expect(screen.getByTestId("restriction-override-note")).toHaveTextContent("by Pat R");
    expect(get).not.toHaveBeenCalled();
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
