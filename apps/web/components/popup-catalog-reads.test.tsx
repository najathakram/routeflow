import * as React from "react";
import * as fs from "fs";
import * as path from "path";
import { render, waitFor, act } from "@testing-library/react";
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
    if (!/isOpen/.test(code)) return;
    expect(/useProducts\([^)]*limit:\s*0/.test(code)).toBe(false);
  });
});
