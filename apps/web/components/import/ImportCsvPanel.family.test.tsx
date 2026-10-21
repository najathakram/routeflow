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
        errorCode: "IMPORT_FAMILY_PRICING_ON",
        error: "RAW SERVER TEXT",
      },
    });
    await tick();
    const banner = screen.getByTestId(`${P}-job`);
    expect(banner).toHaveTextContent("The import stopped before it finished.");
    expect(banner).toHaveTextContent("3 created, 20 updated, 1 unchanged, 2 skipped");
    expect(banner).toHaveTextContent("Re-running the same file is safe.");
    expect(banner).toHaveTextContent("Family pricing is on, so grouping would change these");
    expect(banner).not.toHaveTextContent("RAW SERVER TEXT");
    expect(screen.getByTestId(`${P}-import-button`)).not.toBeDisabled();
  });

  it("gives up after repeated poll failures, says it may still be running, and does NOT say re-running is safe", async () => {
    await startApply();
    get.mockRejectedValue(new Error("network"));
    await tick(2000 * 5);
    const banner = screen.getByTestId(`${P}-job`);
    expect(banner).toHaveTextContent(
      "We lost contact with the import. It may still be running — check Products before importing again.",
    );
    expect(banner).not.toHaveTextContent("safe");
  });

  it("MUST-2: a failed job never shows server text; an unknown code gets the fixed fallback", async () => {
    await startApply();
    get.mockResolvedValueOnce({
      data: {
        id: "job-1",
        state: "failed",
        progress: 5,
        errorCode: "SOMETHING_NEW",
        error: "RAW SERVER TEXT",
      },
    });
    await tick();
    const banner = screen.getByTestId(`${P}-job`);
    expect(banner).not.toHaveTextContent("RAW SERVER TEXT");
    expect(banner).not.toHaveTextContent("SOMETHING_NEW");
    expect(banner).toHaveTextContent("Something went wrong while importing.");
  });

  it("maps the read-only code to fixed copy", async () => {
    await startApply();
    get.mockResolvedValueOnce({
      data: { id: "job-1", state: "failed", progress: 0, errorCode: "READ_ONLY" },
    });
    await tick();
    expect(screen.getByTestId(`${P}-job`)).toHaveTextContent(
      "This workspace can't make changes right now, so the import didn't run.",
    );
  });

  it("onImported fires exactly once even when a slow poll overlaps the next tick", async () => {
    const { onImported } = await startApply();
    let resolve!: (v: unknown) => void;
    get.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    await tick(6000); // three ticks while the first response is still pending
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ data: { id: "job-1", state: "done", progress: 100, result: doneResult } });
    });
    await tick(6000);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("a done job with no result shows a fixed Import finished panel and still calls onImported", async () => {
    const { onImported } = await startApply();
    get.mockResolvedValueOnce({ data: { id: "job-1", state: "done", progress: 100 } });
    await tick();
    expect(screen.getByTestId(`${P}-summary`)).toHaveTextContent("Import finished");
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("the progress bar is labelled and the percent line is a polite live region", async () => {
    await startApply();
    get.mockResolvedValueOnce({ data: { id: "job-1", state: "running", progress: 25 } });
    await tick();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-label", "Import progress");
    expect(screen.getByTestId(`${P}-job-progress-text`)).toHaveAttribute("aria-live", "polite");
  });

  it("the file input and drop zone are disabled while a job runs", async () => {
    await startApply();
    expect(screen.getByTestId(`${P}-file-input`)).toBeDisabled();
    expect(screen.getByTestId(`${P}-dropzone`)).toHaveAttribute("aria-disabled", "true");
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

describe("ImportCsvPanel: a refused preview says why, inline and in fixed words (B980)", () => {
  const refuse = (status: number, code: string) =>
    post.mockRejectedValueOnce({
      response: { status, data: { code, message: "RAW SERVER TEXT" } },
    });

  it("family pricing on (409): the reason is shown on the page, Import stays off, no generic toast", async () => {
    setup();
    refuse(409, "IMPORT_FAMILY_PRICING_ON");
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${P}-preview-button`));
    });
    const gate = screen.getByTestId(`${P}-gate-error`);
    expect(gate).toHaveTextContent(
      "Family pricing is on, so grouping would change these products' prices. Turn family pricing off, or group them in the product editor.",
    );
    expect(gate).not.toHaveTextContent("RAW SERVER TEXT");
    expect(screen.getByTestId(`${P}-import-button`)).toBeDisabled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("too many rows (400): says to split the file, not that the file could not be read", async () => {
    setup();
    refuse(400, "IMPORT_FAMILY_TOO_MANY_ROWS");
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${P}-preview-button`));
    });
    const gate = screen.getByTestId(`${P}-gate-error`);
    expect(gate).toHaveTextContent(/too many rows/i);
    expect(gate).toHaveTextContent("Split it into smaller files");
    expect(gate).not.toHaveTextContent("couldn't be read");
  });

  it("the shared toast copy knows both codes too", () => {
    const { genericToastCopy } = jest.requireActual("@/lib/generic-toast-copy");
    expect(
      genericToastCopy({ response: { status: 409, data: { code: "IMPORT_FAMILY_PRICING_ON" } } }),
    ).toMatch(/Family pricing is on/);
    expect(
      genericToastCopy({
        response: { status: 400, data: { code: "IMPORT_FAMILY_TOO_MANY_ROWS" } },
      }),
    ).toMatch(/too many rows/i);
  });
});

describe("ImportCsvPanel: layout, focus and state hygiene (UI proof)", () => {
  it("Preview, Import and the columns toggle are 44 px targets; the row wraps and Import never breaks across lines", async () => {
    setup();
    for (const id of ["preview-button", "import-button", "columns-toggle"]) {
      expect(screen.getByTestId(`${P}-${id}`).className).toContain("min-h-[44px]");
    }
    expect(screen.getByTestId(`${P}-import-button`).className).toContain("whitespace-nowrap");
    expect(screen.getByTestId(`${P}-actions`).className).toContain("flex-wrap");
  });

  it("focus moves to the preview result after Preview", async () => {
    setup();
    await preview(familyPreview);
    expect(document.activeElement).toBe(screen.getByTestId(`${P}-summary`));
  });

  it("focus moves to the banner when a queued import starts, and again when it stops", async () => {
    setup();
    await preview(familyPreview);
    post.mockResolvedValueOnce({
      data: base({ dryRun: false, queued: { jobId: "job-1", rows: 300 } }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${P}-import-button`));
    });
    expect(document.activeElement).toBe(screen.getByTestId(`${P}-job`));
    (document.activeElement as HTMLElement).blur();
    get.mockResolvedValueOnce({
      data: { id: "job-1", state: "failed", progress: 5, errorCode: "X" },
    });
    await tick();
    expect(document.activeElement).toBe(screen.getByTestId(`${P}-job`));
  });

  it("focus moves to the result when the job is done", async () => {
    setup();
    await preview(familyPreview);
    post.mockResolvedValueOnce({
      data: base({ dryRun: false, queued: { jobId: "job-1", rows: 300 } }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${P}-import-button`));
    });
    get.mockResolvedValueOnce({
      data: { id: "job-1", state: "done", progress: 100, result: base({ dryRun: false }) },
    });
    await tick();
    expect(document.activeElement).toBe(screen.getByTestId(`${P}-summary`));
  });

  it("Preview is disabled while a job runs, and the old preview box is relabelled Last preview", async () => {
    setup();
    await preview(familyPreview);
    expect(screen.getByTestId(`${P}-summary`)).toHaveTextContent("Preview — ");
    post.mockResolvedValueOnce({
      data: base({ dryRun: false, queued: { jobId: "job-1", rows: 300 } }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`${P}-import-button`));
    });
    expect(screen.getByTestId(`${P}-preview-button`)).toBeDisabled();
    expect(screen.getByTestId(`${P}-summary`)).toHaveTextContent("Last preview — ");
    get.mockResolvedValueOnce({
      data: { id: "job-1", state: "failed", progress: 5, errorCode: "X" },
    });
    await tick();
    expect(screen.getByTestId(`${P}-summary`)).toHaveTextContent("Last preview — ");
    expect(screen.getByTestId(`${P}-preview-button`)).not.toBeDisabled();
  });
});
