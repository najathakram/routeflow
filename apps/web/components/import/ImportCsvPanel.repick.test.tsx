/**
 * B1377 follow-up (read B of #4394, L1 + L2).
 *
 * L1: a browser fires no `change` when the user picks the same file again, so an edited CSV
 * re-picked from the same path left the old File in place. user-event's `upload` models that
 * rule (an unchanged selection dispatches nothing), so these tests fail while the input keeps
 * its value after a pick.
 *
 * L2: gated columns are skipped and named, never refused (SA-1193), so a 403 without a server
 * message is a permission refusal, not "This column needs an add-on".
 */
import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportCsvPanel, type ImportCsvResult } from "./ImportCsvPanel";

const post = jest.fn();
const toast = jest.fn();

jest.mock("@/lib/export", () => ({ downloadCsv: jest.fn() }));
jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const columns = [
  { field: "name", canonical: "Item Name", aliases: ["Item Name", "Name"] },
  { field: "sku", canonical: "SKU", aliases: ["SKU", "Item Code"] },
];

const previewResult: ImportCsvResult = {
  created: 1,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  errors: [],
  rows: [{ row: 1, label: "Acme Widget", action: "create", changes: {} }],
  skippedRows: [],
  warnings: [],
  unknownColumns: [],
  dryRun: true,
};

const csv = () => new File(["Item Name\nAcme Widget"], "products.csv", { type: "text/csv" });

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
  return screen.getByTestId("products-file-input") as HTMLInputElement;
}

const sentFile = (call: number) => (post.mock.calls[call][1] as FormData).get("file");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ImportCsvPanel: picking the same file again (L1)", () => {
  it("clears the input after a pick, so the same file can be picked again", async () => {
    const user = userEvent.setup();
    const input = renderPanel();
    await user.upload(input, csv());
    expect(input.value).toBe("");
    expect(input.files).toHaveLength(0);
  });

  it("a re-pick of the same file after a preview starts over and previews the new pick", async () => {
    const user = userEvent.setup();
    const input = renderPanel();
    const file = csv();
    post.mockResolvedValue({ data: previewResult });

    await user.upload(input, file);
    await user.click(screen.getByTestId("products-preview-button"));
    expect(await screen.findByText("Acme Widget")).toBeInTheDocument();
    expect(screen.getByTestId("products-import-button")).toBeEnabled();

    // The user edits the CSV and picks it again from the same place.
    await user.upload(input, file);
    expect(screen.queryByText("Acme Widget")).not.toBeInTheDocument();
    expect(screen.getByTestId("products-import-button")).toBeDisabled();

    await user.click(screen.getByTestId("products-preview-button"));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(sentFile(1)).toBe(file);
  });
});

describe("ImportCsvPanel: a 403 with no message (L2)", () => {
  it("says the user lacks permission, never that a column needs an add-on", async () => {
    const user = userEvent.setup();
    const input = renderPanel();
    post.mockRejectedValueOnce({ response: { status: 403, data: {} } });

    await user.upload(input, csv());
    await user.click(screen.getByTestId("products-preview-button"));

    const gate = await screen.findByTestId("products-gate-error");
    expect(gate).toHaveTextContent("You don’t have permission to import this file.");
    expect(gate).not.toHaveTextContent(/add-on/i);
  });

  it("still shows the server's own 403 message when there is one", async () => {
    const user = userEvent.setup();
    const input = renderPanel();
    post.mockRejectedValueOnce({
      response: { status: 403, data: { message: "Only an admin can import products" } },
    });

    await user.upload(input, csv());
    await user.click(screen.getByTestId("products-preview-button"));

    expect(await screen.findByTestId("products-gate-error")).toHaveTextContent(
      "Only an admin can import products",
    );
  });
});
