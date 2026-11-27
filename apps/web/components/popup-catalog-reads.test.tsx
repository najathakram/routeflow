import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, waitFor, act, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { InlineCreateProductModal } from "./InlineCreateProductModal";
import { ProductCreateModal } from "./ProductCreateModal";
import { GroupAsVariantsModal } from "./GroupAsVariantsModal";
import { AssignProductsModal } from "./AssignProductsModal";

/**
 * W-1413 (REG-W1413-closed-popup-catalog-read). A popup is MOUNTED by its page even while it is closed (the order draft
 * mounts the New product popup on every load). Each of these four read the WHOLE catalog (`GET /products?limit=0`: up
 * to 10,000 rows, a signed thumbnail each) from a hook that runs before their `if (!isOpen) return null`, so the order
 * draft downloaded the full catalog on every load and re-fetched it after every product save, which froze a tablet.
 * Wrong value today: `GET /products` with `limit: 0` while `isOpen` is false.
 */
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const get = apiClient.get as jest.Mock;
const fullCatalogReads = () =>
  get.mock.calls.filter(
    ([url, cfg]) =>
      url === "/products" && (cfg as { params?: { limit?: number } })?.params?.limit === 0,
  );

const category = { id: "cat-1", name: "Acme Category" } as never;
const popups: Record<string, (isOpen: boolean) => React.ReactElement> = {
  InlineCreateProductModal: (isOpen) => (
    <InlineCreateProductModal isOpen={isOpen} onClose={jest.fn()} onCreated={jest.fn()} />
  ),
  ProductCreateModal: (isOpen) => (
    <ProductCreateModal isOpen={isOpen} onClose={jest.fn()} onCreated={jest.fn()} />
  ),
  GroupAsVariantsModal: (isOpen) => (
    <GroupAsVariantsModal isOpen={isOpen} onClose={jest.fn()} selectedIds={[]} />
  ),
  AssignProductsModal: (isOpen) => (
    <AssignProductsModal isOpen={isOpen} onClose={jest.fn()} category={category} />
  ),
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/products" ? { data: [], meta: { total: 0 } } : [] }),
  );
});

describe.each(Object.keys(popups))("%s catalog read", (name) => {
  const tree = (qc: QueryClient, isOpen: boolean) => (
    <QueryClientProvider client={qc}>{popups[name](isOpen)}</QueryClientProvider>
  );

  it("does not read the whole catalog while it is closed", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(tree(qc, false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fullCatalogReads()).toHaveLength(0);
  });

  it("does not re-read it when a product save invalidates the product set while closed", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(tree(qc, false));
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["products"] });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(fullCatalogReads()).toHaveLength(0);
  });

  it("reads it once it is opened", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(tree(qc, false));
    view.rerender(tree(qc, true));
    await waitFor(() => expect(fullCatalogReads().length).toBeGreaterThan(0));
  });
});

/**
 * W-1413 F2 (R-324). A reopen must seed the checkboxes from FRESH data. A product joins the category while the modal is
 * closed (the product set is invalidated, the disabled query does not refetch); on reopen the stale cache must not seed
 * the boxes, or Save with no change unassigns that product. Master read the catalog always-on, so it posted nothing.
 */
describe("AssignProductsModal reopen", () => {
  it("saving with no change after a reopen sends no unassign request", async () => {
    let p2Assigned = false;
    get.mockImplementation((url: string) => {
      if (url === "/products") {
        return Promise.resolve({
          data: {
            data: [
              { id: "p1", name: "Acme One", trackedCategoryId: "cat-1" },
              { id: "p2", name: "Acme Two", trackedCategoryId: p2Assigned ? "cat-1" : null },
            ],
            meta: { total: 2 },
          },
        });
      }
      return Promise.resolve({ data: [] });
    });
    const post = apiClient.post as jest.Mock;
    post.mockReset();
    post.mockResolvedValue({ data: {} });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const tree = (isOpen: boolean) => (
      <QueryClientProvider client={qc}>{popups.AssignProductsModal(isOpen)}</QueryClientProvider>
    );
    const view = render(tree(true));
    await screen.findByText("Acme Two");
    view.rerender(tree(false));
    p2Assigned = true;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["products"] });
    });
    view.rerender(tree(true));
    await waitFor(() => {
      const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      expect(boxes).toHaveLength(2);
      expect(boxes.every((b) => b.checked)).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * Inventory pin: a popup / sheet / dialog file may not call the products hook with `limit: 0` itself. The gated helper
 * `useCatalogWhenOpen` is the one door, so a fifth popup cannot bring the closed-read back. Only popups the page keeps
 * mounted (they take an `isOpen` prop) can read while closed; one the page mounts only when open is exempt.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/(Modal|Sheet|Dialog|Popup).*\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name))
      out.push(p);
  }
  return out;
}

describe("no popup file reads the whole catalog directly", () => {
  const root = path.join(__dirname, "..");
  const files = [...walk(path.join(root, "components")), ...walk(path.join(root, "app"))];
  it("scans popup files", () => expect(files.length).toBeGreaterThan(20));
  it.each(files.map((f) => [path.relative(root, f), f]))("%s", (_rel, f) => {
    const code = fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    if (!/\bisOpen\b/.test(code)) return;
    expect(/useProducts\([^)]*limit:\s*0/.test(code)).toBe(false);
  });
});
