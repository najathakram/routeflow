/**
 * SA-1193 K5 7 (B1377): a gated column the tenant lacks is skipped by the server and named in `skippedColumns`. The panel
 * shows one warning notice in fixed sentences (never a server sentence), and Import stays enabled. A1-2: the add-on's
 * name in that sentence is the server's `label` (the billing page's own name), never typed in the copy.
 */
import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportCsvPanel, type ImportCsvResult } from "./ImportCsvPanel";

const post = jest.fn();
const toast = jest.fn();

jest.mock("@/lib/export", () => ({ downloadCsv: jest.fn() }));
jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const columns = [{ field: "name", canonical: "Item Name", aliases: ["Item Name"] }];

const result = (over: Partial<ImportCsvResult> = {}): ImportCsvResult => ({
  created: 1,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  errors: [],
  rows: [{ row: 1, label: "Widget", action: "create", changes: {} }],
  skippedRows: [],
  warnings: [],
  unknownColumns: [],
  dryRun: true,
  skippedColumns: [
    { column: "MSRP", requires: "MSRP", label: "MSRP on invoices" },
    { column: "Retail Price", requires: "MSRP", label: "MSRP on invoices" },
    { column: "Tobacco", requires: "TOBACCO_DEALER", label: "Regulated items" },
    { column: "Reorder Point", requires: "FORECASTING", label: "Forecasting" },
    { column: "Reorder Qty", requires: "FORECASTING", label: "Forecasting" },
  ],
  ...over,
});

function renderPanel() {
  render(
    <ImportCsvPanel
      template={{ headers: ["Item Name"], fileName: "t.csv" }}
      endpoint="/import/products"
      title="Products"
      columns={columns}
      testIdPrefix="products"
    />,
  );
  const input = screen.getByTestId("products-file-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["Item Name\nWidget"], "p.csv", { type: "text/csv" })] },
  });
}

beforeEach(() => jest.clearAllMocks());

describe("ImportCsvPanel: skipped gated columns (SA-1193)", () => {
  it("the preview names each skipped header by what it needs, in fixed words, and keeps Import enabled", async () => {
    post.mockResolvedValueOnce({ data: result() });
    renderPanel();
    fireEvent.click(screen.getByTestId("products-preview-button"));

    const notice = await screen.findByTestId("products-skipped-columns");
    expect(notice).toHaveTextContent("These columns won’t be imported");
    expect(notice).toHaveTextContent("“MSRP” and “Retail Price” need the MSRP on invoices add-on.");
    expect(notice).toHaveTextContent("“Tobacco” needs the Regulated items add-on.");
    expect(notice).toHaveTextContent("“Reorder Point” and “Reorder Qty” need Forecasting.");
    expect(notice).toHaveTextContent("Your other columns import as shown below.");
    // a next step only where it is true: Forecasting is self-serve on Plan & billing; MSRP and Tobacco have none
    const link = screen.getByRole("link", { name: "Plan & billing" });
    expect(link).toHaveAttribute("href", "/settings/billing");
    expect(notice).not.toHaveTextContent(/change your plan|isn.t on your plan|Everything else/i);
    expect(notice).not.toHaveTextContent(/TOBACCO_DEALER|FORECASTING|tobacco_dealer|plan flag/);
    expect(screen.getByTestId("products-import-button")).toBeEnabled();
    expect(screen.queryByTestId("products-gate-error")).not.toBeInTheDocument();
  });

  it("one skipped column reads in the singular, with no next step for a managed add-on", async () => {
    post.mockResolvedValueOnce({
      data: result({
        skippedColumns: [{ column: "MSRP", requires: "MSRP", label: "MSRP on invoices" }],
      }),
    });
    renderPanel();
    fireEvent.click(screen.getByTestId("products-preview-button"));

    const notice = await screen.findByTestId("products-skipped-columns");
    expect(notice).toHaveTextContent("This column won’t be imported");
    expect(notice).toHaveTextContent("“MSRP” needs the MSRP on invoices add-on.");
    expect(screen.queryByRole("link", { name: "Plan & billing" })).not.toBeInTheDocument();
  });

  it("after Import the notice and the toast say the columns weren’t imported", async () => {
    post.mockResolvedValueOnce({ data: result() });
    post.mockResolvedValueOnce({ data: result({ dryRun: false }) });
    renderPanel();
    fireEvent.click(screen.getByTestId("products-preview-button"));
    await screen.findByTestId("products-skipped-columns");
    fireEvent.click(screen.getByTestId("products-import-button"));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = screen.getByTestId("products-skipped-columns");
    expect(notice).toHaveTextContent("These columns weren’t imported");
    expect(notice).toHaveTextContent("Your other columns were imported as shown below.");
    expect(toast.mock.calls[0][0].description).toContain("Some columns weren’t imported.");
  });

  it("SA-1193 A1-2: the name is the server's label (the billing page's), so a renamed add-on reads with its new name", async () => {
    post.mockResolvedValueOnce({
      data: result({
        skippedColumns: [
          { column: "Tobacco", requires: "TOBACCO_DEALER", label: "Acme regulated goods" },
          { column: "Reorder Point", requires: "FORECASTING", label: "Acme planning" },
        ],
      }),
    });
    renderPanel();
    fireEvent.click(screen.getByTestId("products-preview-button"));

    const notice = await screen.findByTestId("products-skipped-columns");
    expect(notice).toHaveTextContent("“Tobacco” needs the Acme regulated goods add-on.");
    expect(notice).toHaveTextContent(
      "“Reorder Point” needs Acme planning. You can add Acme planning in Plan & billing.",
    );
    expect(notice).not.toHaveTextContent(/Regulated items|Tobacco dealer|Forecasting/);
  });

  it("SA-1193 A1-2: an older server that sends no label still reads true, with no name and no next step", async () => {
    post.mockResolvedValueOnce({
      data: result({
        skippedColumns: [
          { column: "Tobacco", requires: "TOBACCO_DEALER" },
          { column: "Reorder Point", requires: "FORECASTING" },
        ] as unknown as ImportCsvResult["skippedColumns"],
      }),
    });
    renderPanel();
    fireEvent.click(screen.getByTestId("products-preview-button"));

    const notice = await screen.findByTestId("products-skipped-columns");
    expect(notice).toHaveTextContent("“Tobacco” needs an add-on.");
    expect(notice).toHaveTextContent("“Reorder Point” needs an add-on.");
    expect(notice).not.toHaveTextContent(/undefined/);
    expect(screen.queryByRole("link", { name: "Plan & billing" })).not.toBeInTheDocument();
  });

  it("SA-1193 A1-2: the notice copy types no add-on name (grep pin on the copy file)", () => {
    const src = readFileSync(join(process.cwd(), "lib/import-skipped-columns-copy.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(
      /MSRP add-on|MSRP on invoices|Tobacco dealer|Regulated items|Forecasting/,
    );
  });

  it("no notice when nothing was skipped, or when an older server sends no list", async () => {
    post.mockResolvedValueOnce({ data: result({ skippedColumns: [] }) });
    renderPanel();
    fireEvent.click(screen.getByTestId("products-preview-button"));
    await screen.findByTestId("products-results-table");
    expect(screen.queryByTestId("products-skipped-columns")).not.toBeInTheDocument();
  });
});
