import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { RuleFormDialog } from "./RuleFormDialog";

const get = jest.fn();
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

const CATS = [
  {
    id: "c1",
    name: "Hemp",
    archivedAt: null,
    createdAt: "",
    productCount: 0,
    activeRestrictionCount: 0,
  },
];
beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/product-categories" ? CATS : { data: [] } }),
  );
});

const open = (onClose = jest.fn()) => {
  renderWithProviders(<RuleFormDialog open onClose={onClose} />);
  return onClose;
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

describe("RuleFormDialog", () => {
  it("shows plain-words errors and makes no request for an empty form", async () => {
    open();
    submit();
    expect(await screen.findByText("Pick a category")).toBeInTheDocument();
    expect(screen.getByText("Pick at least one state")).toBeInTheDocument();
    expect(screen.getByText("Add a reason")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the shaped request for a state rule, then closes", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    const onClose = open();
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Texas/ }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  State ban  " } });
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/selling-restrictions", {
      categoryId: "c1",
      jurisdiction: "STATE",
      states: ["TX"],
      surface: "ALL",
      reason: "State ban",
    });
  });

  it("a federal rule hides the state picker and sends no states", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    open();
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.click(screen.getByRole("radio", { name: "Everywhere (federal)" }));
    expect(screen.queryByRole("group", { name: "States" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Federal ban" } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).not.toHaveProperty("states");
  });

  it("a refused create keeps the dialog open with the entered values", async () => {
    post.mockRejectedValueOnce(new Error("That category is archived"));
    const onClose = open();
    await screen.findByRole("option", { name: "Hemp" });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Texas/ }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Ban" } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("Ban");
  });

  it("a product rule: search, pick by name, send productId", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({
        data:
          url === "/product-categories"
            ? CATS
            : { data: [{ id: "p9", name: "Gummies 10ct", sku: "G10" }] },
      }),
    );
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    open();
    fireEvent.click(screen.getByRole("radio", { name: "One product" }));
    fireEvent.change(screen.getByLabelText("Search products"), { target: { value: "gum" } });
    fireEvent.click(await screen.findByRole("button", { name: /Gummies 10ct/ }, { timeout: 2000 }));
    expect(screen.getByText("Gummies 10ct")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Everywhere (federal)" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Federal ban" } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ productId: "p9", jurisdiction: "FEDERAL" });
    expect(post.mock.calls[0][1]).not.toHaveProperty("categoryId");
  });
});
