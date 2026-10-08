import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import type { QuickKey } from "@routeflow/types";
import { QuickKeysEditModal, QUICK_KEYS_SAVE_FAILED_COPY } from "./QuickKeysEditModal";

/**
 * SA-747: the "Edit keys" editor. It works on a draft of the saved pins / hides; Save sends the whole `quickKeys` setting
 * through PATCH /settings, Cancel sends nothing, a failed save shows fixed copy (never the server's text).
 */

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));
const get = apiClient.get as unknown as jest.Mock;
const patch = apiClient.patch as unknown as jest.Mock;

const key = (id: string, name: string, pinned: boolean): QuickKey => ({
  productId: id,
  name,
  sellLevel: "UNIT",
  pinned,
  product: { id },
});
const KEYS = [key("p-a", "Alpha", true), key("p-b", "Bravo", true), key("p-c", "Charlie", false)];
const PRODUCTS = [
  { id: "p-d", name: "Delta", sku: "SKU-D", pricePerUnit: 9.99 },
  { id: "p-e", name: "Echo", sku: "SKU-E", pricePerUnit: 5 },
];
let savedQuickKeys: unknown;

beforeEach(() => {
  jest.clearAllMocks();
  savedQuickKeys = {
    counter: { default: { pinned: ["p-a", "p-b"], hidden: [] }, windowDays: 14, cap: 12 },
  };
  get.mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0, quickKeys: savedQuickKeys } };
    if (url === "/products") {
      const q = String(cfg?.params?.search ?? "").toLowerCase();
      return {
        data: {
          data: PRODUCTS.filter(
            (p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q),
          ),
        },
      };
    }
    if (url === "/products/p-z") return { data: { id: "p-z", name: "Zulu" } };
    throw new Error(`unexpected GET ${url}`);
  });
  patch.mockResolvedValue({ data: {} });
});

const onClose = jest.fn();
async function open(cap = 12) {
  const r = renderWithProviders(<QuickKeysEditModal keys={KEYS} cap={cap} onClose={onClose} />);
  await waitFor(() => expect(get).toHaveBeenCalledWith("/settings"));
  await screen.findByTestId("quick-keys-editor");
  return r;
}
const search = async (text: string) => {
  fireEvent.change(screen.getByLabelText("Find a product to pin"), { target: { value: text } });
  return screen.findByRole("list", { name: "Search results" });
};
const names = () =>
  within(screen.getByRole("region", { name: "Pinned keys" }))
    .queryAllByRole("listitem")
    .map((li) => li.querySelector("span")?.textContent);

describe("QuickKeysEditModal", () => {
  it("lists the saved pins in order with 'n of cap pinned'", async () => {
    await open();
    await waitFor(() =>
      expect(screen.getByTestId("quick-keys-pin-count")).toHaveTextContent("2 of 12 pinned"),
    );
    expect(names()).toEqual(["Alpha", "Bravo"]);
  });

  it("pins a searched product and Save sends the exact quickKeys shape", async () => {
    await open();
    const results = await search("delta");
    expect(results.textContent).toContain("SKU-D");
    expect(results.textContent).not.toMatch(/\$|9\.99/); // no prices
    fireEvent.click(within(results).getByRole("button", { name: "Pin Delta" }));
    expect(names()).toEqual(["Alpha", "Bravo", "Delta"]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const list = { pinned: ["p-a", "p-b", "p-d"], hidden: [] };
    expect(patch).toHaveBeenCalledWith("/settings", {
      quickKeys: {
        counter: { windowDays: 14, cap: 12, default: list, registers: { main: list } },
      },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("at the cap, adding is disabled and the count says so", async () => {
    await open(2);
    await waitFor(() =>
      expect(screen.getByTestId("quick-keys-pin-count")).toHaveTextContent("2 of 2 pinned"),
    );
    const results = await search("echo");
    expect(within(results).getByRole("button", { name: "Pin Echo" })).toBeDisabled();
    fireEvent.click(within(results).getByRole("button", { name: "Pin Echo" }));
    expect(names()).toEqual(["Alpha", "Bravo"]);
  });

  it("a pinned product shows as pinned in the results and cannot be added twice", async () => {
    savedQuickKeys = { counter: { default: { pinned: ["p-d"], hidden: [] } } };
    await open();
    const results = await search("delta");
    expect(within(results).getByRole("button", { name: "Delta is pinned" })).toBeDisabled();
  });

  it("moves a pin up and down, and the ends are disabled", async () => {
    await open();
    await waitFor(() => expect(names()).toEqual(["Alpha", "Bravo"]));
    expect(screen.getByRole("button", { name: "Move Alpha up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Bravo down" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Move Bravo up" }));
    expect(names()).toEqual(["Bravo", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "Move Bravo down" }));
    expect(names()).toEqual(["Alpha", "Bravo"]);
    fireEvent.click(screen.getByRole("button", { name: "Move Alpha down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1].quickKeys.counter.registers.main.pinned).toEqual(["p-b", "p-a"]);
  });

  it("unpins", async () => {
    await open();
    await waitFor(() => expect(names()).toEqual(["Alpha", "Bravo"]));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Alpha" }));
    expect(names()).toEqual(["Bravo"]);
    expect(screen.getByTestId("quick-keys-pin-count")).toHaveTextContent("1 of 12 pinned");
  });

  it("hides a ranked product and unhides it again", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Hide Charlie" }));
    expect(screen.queryByRole("button", { name: "Hide Charlie" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Hidden products \(1\)/ }));
    fireEvent.click(screen.getByRole("button", { name: "Unhide Charlie" }));
    expect(screen.getByRole("button", { name: "Hide Charlie" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide Charlie" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0][1].quickKeys.counter.registers.main).toEqual({
      pinned: ["p-a", "p-b"],
      hidden: ["p-c"],
    });
  });

  it("names a previously hidden product (not in the grid) by fetching it once the section is opened", async () => {
    savedQuickKeys = { counter: { default: { pinned: [], hidden: ["p-z"] } } };
    await open();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Hidden products \(1\)/ })).toBeInTheDocument(),
    );
    expect(get).not.toHaveBeenCalledWith("/products/p-z");
    fireEvent.click(screen.getByRole("button", { name: /Hidden products \(1\)/ }));
    expect(await screen.findByRole("button", { name: "Unhide Zulu" })).toBeInTheDocument();
  });

  it("Cancel sends nothing and closes", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Unpin Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(patch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("a failed save shows the fixed line, never the server's message, and stays open", async () => {
    patch.mockRejectedValue({
      response: { status: 400, data: { message: "pinned must have at most 12" } },
    });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Unpin Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(QUICK_KEYS_SAVE_FAILED_COPY);
    expect(document.body.textContent).not.toContain("at most 12");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});
