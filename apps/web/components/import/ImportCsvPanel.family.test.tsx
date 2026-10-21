import * as React from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { ImportCsvPanel, type ImportCsvResult } from "./ImportCsvPanel";

const post = jest.fn();
const get = jest.fn();
const toast = jest.fn();

jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) },
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));

const columns = [{ field: "name", canonical: "Item Name", aliases: ["Item Name"] }];
const P = "products";

const base = (over: Partial<ImportCsvResult> = {}): ImportCsvResult => ({
  created: 0,
  updated: 3,
  unchanged: 0,
  skipped: 1,
  errors: [],
  rows: [],
  skippedRows: [],
  warnings: [],
  unknownColumns: [],
  dryRun: true,
  ...over,
});

const familyPreview = base({
  rows: [
    {
      row: 1,
      label: "Zero",
      action: "update",
      changes: { family: { from: "Old Family", to: "Acme Cola" } },
      family: {
        matchedBy: "sku",
        name: "Acme Cola",
        state: "new",
        variantName: "Zero",
        displayName: "Acme Cola - Zero",
        movesFrom: "Old Family",
        stock: 4,
      },
    },
  ],
  families: {
    familiesToCreate: [{ name: "Acme Cola", rows: 3 }],
    grouped: 3,
    newVariants: 1,
    moves: 1,
    skipsByReason: [
      { reason: "Add the product's id, SKU or barcode to move it into a family.", count: 2 },
    ],
    deactivated: [],
    cleanupFailed: [],
  },
});

function setup() {
  const onImported = jest.fn();
  render(
    <ImportCsvPanel
      endpoint="/import/products"
      title="Products"
      columns={columns}
      testIdPrefix={P}
      onImported={onImported}
    />,
  );
  const input = screen.getByTestId(`${P}-file-input`) as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["Item Name\nx"], "p.csv", { type: "text/csv" })] },
  });
  return { onImported };
}

async function preview(data: ImportCsvResult) {
  post.mockResolvedValueOnce({ data });
  await act(async () => {
    fireEvent.click(screen.getByTestId(`${P}-preview-button`));
  });
}

async function tick(ms = 2000) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("ImportCsvPanel: families preview block", () => {
  it("shows new families, grouped, moves and what was left out, in plain words", async () => {
    setup();
    await preview(familyPreview);
    const block = screen.getByTestId(`${P}-families`);
    expect(screen.getByTestId(`${P}-families-new`)).toHaveTextContent("Acme Cola (3 items)");
    expect(block).toHaveTextContent("3 products will join a family");
    expect(block).toHaveTextContent("1 new item will be added to families");
    expect(block).toHaveTextContent("1 product will move to another family");
    expect(screen.getByTestId(`${P}-families-skips`)).toHaveTextContent(
      "Add the product's id, SKU or barcode to move it into a family. (2)",
    );
  });

  it("shows the family name and where a product moves from, under the row name", async () => {
    setup();
    await preview(familyPreview);
    expect(screen.getByTestId(`${P}-row-1`)).toHaveTextContent(
      "Acme Cola - Zero · moves from Old Family",
    );
  });

  it("renders no family block for a file without a Family column", async () => {
    setup();
    await preview(base());
    expect(screen.queryByTestId(`${P}-families`)).toBeNull();
  });
});

describe("ImportCsvPanel: a queued apply", () => {
  const queued = base({
    dryRun: false,
    queued: { jobId: "job-1", rows: 300 },
    created: 0,
    updated: 0,
    skipped: 0,
  });
  const doneResult = base({
    dryRun: false,
    updated: 299,
    skipped: 1,
    families: {
      familiesToCreate: [],
      grouped: 299,
      newVariants: 0,
      moves: 0,
      skipsByReason: [],
      deactivated: [],
      cleanupFailed: [{ name: "Ghost Family" }],
    },
  });

  async function startApply() {
    const ctx = setup();
    await preview(familyPreview);
    post.mockResolvedValueOnce({ data: queued });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${P}-import-button`));
    });
    return ctx;
  }

  it("says it is importing in the background and disables Import while the job runs", async () => {
    await startApply();
    expect(screen.getByTestId(`${P}-job`)).toHaveTextContent(
      "Importing 300 rows in the background",
    );
    expect(screen.getByTestId(`${P}-import-button`)).toBeDisabled();
    expect(post.mock.calls[1][0]).toBe("/import/products?dryRun=false");
    expect(screen.queryByTestId(`${P}-summary`)?.textContent ?? "").not.toContain(
      "Import complete",
    );
  });

  it("polls the job and shows progress with the running counts", async () => {
    await startApply();
    get.mockResolvedValueOnce({
      data: {
        id: "job-1",
        state: "running",
        progress: 40,
        counts: { created: 0, updated: 120, unchanged: 0, skipped: 2 },
      },
    });
    await tick();
    expect(get).toHaveBeenCalledWith("/import/products/jobs/job-1");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByTestId(`${P}-job`)).toHaveTextContent("40% done");
    expect(screen.getByTestId(`${P}-job`)).toHaveTextContent("120 updated, 2 skipped so far");
    expect(screen.getByTestId(`${P}-import-button`)).toBeDisabled();
  });

  it("on done, shows the same result panel as a synchronous apply, calls onImported once, and stops polling", async () => {
    const { onImported } = await startApply();
    get.mockResolvedValueOnce({
      data: { id: "job-1", state: "done", progress: 100, result: doneResult },
    });
    await tick();
    expect(screen.getByTestId(`${P}-summary`)).toHaveTextContent("Import complete");
    expect(screen.getByTestId(`${P}-summary`)).toHaveTextContent("299 updated");
    expect(screen.queryByTestId(`${P}-job`)).toBeNull();
    expect(screen.getByTestId(`${P}-families-stuck`)).toHaveTextContent("Ghost Family");
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Products imported", variant: "success" }),
    );
    const calls = get.mock.calls.length;
    await tick(6000);
    expect(get.mock.calls.length).toBe(calls);
  });

  it("on failed, shows what was saved and that re-running the same file is safe, and lets Import run again", async () => {
    await startApply();
    get.mockResolvedValueOnce({
      data: {
        id: "job-1",
        state: "failed",
        progress: 60,
        counts: { created: 3, updated: 20, unchanged: 1, skipped: 2 },
        error: "Family pricing is on, so grouping would change these products' prices.",
      },
    });
    await tick();
    const banner = screen.getByTestId(`${P}-job`);
    expect(banner).toHaveTextContent("The import stopped before it finished.");
    expect(banner).toHaveTextContent("3 created, 20 updated, 1 unchanged, 2 skipped");
    expect(banner).toHaveTextContent("Re-running the same file is safe.");
    expect(banner).toHaveTextContent("Family pricing is on");
    expect(screen.getByTestId(`${P}-import-button`)).not.toBeDisabled();
  });

  it("gives up after repeated poll failures with the same safe-to-rerun message", async () => {
    await startApply();
    get.mockRejectedValue(new Error("network"));
    await tick(2000 * 5);
    expect(screen.getByTestId(`${P}-job`)).toHaveTextContent("We lost contact with the import.");
    expect(screen.getByTestId(`${P}-job`)).toHaveTextContent("Re-running the same file is safe.");
  });

  it("stops polling when the page goes away", async () => {
    await startApply();
    get.mockResolvedValue({ data: { id: "job-1", state: "running", progress: 10 } });
    await tick();
    const calls = get.mock.calls.length;
    cleanup();
    await tick(6000);
    expect(get.mock.calls.length).toBe(calls);
  });
});
