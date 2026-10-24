import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportCsvPanel, type ImportCsvResult } from "./ImportCsvPanel";

const post = jest.fn();
const toast = jest.fn();

jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const columns = [
  { field: "name", canonical: "Item Name", aliases: ["Item Name", "Name"] },
  { field: "sku", canonical: "SKU", aliases: ["SKU", "Item Code"] },
];

const csvFile = () => new File(["Item Name,SKU\nWidget,W-1"], "products.csv", { type: "text/csv" });

function pickFile(prefix: string) {
  const input = screen.getByTestId(`${prefix}-file-input`) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [csvFile()] } });
}

const previewResult: ImportCsvResult = {
  created: 1,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  errors: [],
  rows: [
    {
      row: 1,
      label: "Widget",
      action: "create",
      changes: { pricePerUnit: { from: null, to: 9.5 } },
    },
  ],
  skippedRows: [],
  warnings: [],
  unknownColumns: [],
  dryRun: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ImportCsvPanel", () => {
  it("previews with dryRun=true and renders the row plan", async () => {
    post.mockResolvedValueOnce({ data: previewResult });
    render(
      <ImportCsvPanel
        endpoint="/import/products"
        title="Products"
        columns={columns}
        testIdPrefix="products"
      />,
    );

    pickFile("products");
    fireEvent.click(screen.getByTestId("products-preview-button"));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe("/import/products?dryRun=true");

    expect(await screen.findByTestId("products-results-table")).toBeInTheDocument();
    expect(screen.getByTestId("products-row-1")).toHaveTextContent("Widget");
    expect(screen.getByTestId("products-row-1")).toHaveTextContent("create");
    expect(screen.getByTestId("products-row-1")).toHaveTextContent("pricePerUnit");
  });

  it("imports with dryRun=false after a preview and shows the final result", async () => {
    post.mockResolvedValueOnce({ data: previewResult });
    post.mockResolvedValueOnce({
      data: { ...previewResult, dryRun: false },
    });
    render(
      <ImportCsvPanel
        endpoint="/import/products"
        title="Products"
        columns={columns}
        testIdPrefix="products"
      />,
    );

    pickFile("products");
    fireEvent.click(screen.getByTestId("products-preview-button"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("products-import-button"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toBe("/import/products?dryRun=false");

    await waitFor(() =>
      expect(screen.getByTestId("products-summary")).toHaveTextContent("Import complete"),
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Products imported" }));
  });

  it("disables Import until a preview has run", () => {
    render(
      <ImportCsvPanel
        endpoint="/import/products"
        title="Products"
        columns={columns}
        testIdPrefix="products"
      />,
    );
    pickFile("products");
    expect(screen.getByTestId("products-import-button")).toBeDisabled();
  });

  it("renders a blocking gate error on a 403 and does not show a preview table", async () => {
    post.mockRejectedValueOnce({
      response: {
        status: 403,
        data: { message: 'Column "MSRP" needs the MSRP plan flag; remove the column or enable it' },
      },
    });
    render(
      <ImportCsvPanel
        endpoint="/import/products"
        title="Products"
        columns={columns}
        testIdPrefix="products"
      />,
    );

    pickFile("products");
    fireEvent.click(screen.getByTestId("products-preview-button"));

    const gate = await screen.findByTestId("products-gate-error");
    expect(gate).toHaveTextContent('Column "MSRP" needs the MSRP plan flag');
    expect(screen.queryByTestId("products-results-table")).not.toBeInTheDocument();
    expect(screen.getByTestId("products-import-button")).toBeDisabled();
  });

  it.each([400, 413])(
    "B986: a %i failure toasts ONE fixed sentence that says what to fix, never the server message",
    async (status) => {
      post.mockRejectedValueOnce({
        response: { status, data: { message: "secret parser detail at row 9" } },
      });
      render(
        <ImportCsvPanel
          endpoint="/import/products"
          title="Products"
          columns={columns}
          testIdPrefix="products"
        />,
      );
      pickFile("products");
      fireEvent.click(screen.getByTestId("products-preview-button"));
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
      const t = toast.mock.calls[0][0];
      expect(t.description).toBe(
        "The file couldn't be read. Check that it is a CSV that follows the template, and split a very large file into smaller ones.",
      );
      expect(JSON.stringify(t)).not.toContain("secret parser detail");
    },
  );

  it("B986: any other import failure is the shared generic copy", async () => {
    post.mockRejectedValueOnce({ response: { status: 500, data: { message: "db down" } } });
    render(
      <ImportCsvPanel
        endpoint="/import/products"
        title="Products"
        columns={columns}
        testIdPrefix="products"
      />,
    );
    pickFile("products");
    fireEvent.click(screen.getByTestId("products-preview-button"));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast.mock.calls[0][0].description).toBe(
      "Something went wrong on our side. Please try again.",
    );
  });

  it("renders unknown columns and warnings from the plan", async () => {
    post.mockResolvedValueOnce({
      data: {
        ...previewResult,
        unknownColumns: ["Average Cost"],
        warnings: ["Tobacco licence expired 2026-01-01"],
      },
    });
    render(
      <ImportCsvPanel
        endpoint="/import/products"
        title="Products"
        columns={columns}
        testIdPrefix="products"
      />,
    );

    pickFile("products");
    fireEvent.click(screen.getByTestId("products-preview-button"));

    expect(await screen.findByTestId("products-unknown-columns")).toHaveTextContent("Average Cost");
    expect(screen.getByTestId("products-warnings")).toHaveTextContent("Tobacco licence expired");
  });

  it("I4: renders skippedRows and errors, and a row the real import failed shows as skip with its reason", async () => {
    // A real-run failure: the API replaces that row's plan entry with action:"skip" + reason
    // (never leaves a stale "create"/"update" badge with the reason reachable only via the
    // summary count) — the panel must surface it from `rows`, plus the dedicated
    // `skippedRows`/`errors` surfaces.
    post.mockResolvedValueOnce({
      data: {
        ...previewResult,
        dryRun: false,
        created: 0,
        skipped: 1,
        errors: ["Widget: SKU already exists"],
        rows: [{ row: 1, label: "Widget", action: "skip", reason: "SKU already exists" }],
        skippedRows: [{ row: 1, label: "Widget", reason: "SKU already exists" }],
      },
    });
    render(
      <ImportCsvPanel
        endpoint="/import/products"
        title="Products"
        columns={columns}
        testIdPrefix="products"
      />,
    );

    pickFile("products");
    fireEvent.click(screen.getByTestId("products-preview-button"));

    await screen.findByTestId("products-results-table");
    expect(screen.getByTestId("products-row-1")).toHaveTextContent("skip");
    expect(screen.getByTestId("products-row-1")).toHaveTextContent("SKU already exists");
    expect(screen.getByTestId("products-skipped-rows")).toHaveTextContent("SKU already exists");
    expect(screen.getByTestId("products-errors")).toHaveTextContent("SKU already exists");
  });
});
