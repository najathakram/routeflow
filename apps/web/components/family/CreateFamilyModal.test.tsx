import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { CreateFamilyModal } from "./CreateFamilyModal";

/**
 * WS8 create dialog end to end: the REAL global MutationCache handler (app/providers.tsx) around the
 * real dialog, only the network mocked — so "one toast" and "no raw server text" are proven, not assumed.
 */
const toast = jest.fn();
const post = jest.fn();
const get = jest.fn();
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) },
}));

const onClose = jest.fn();
const mount = () =>
  render(
    <Providers>
      <CreateFamilyModal open onClose={onClose} />
    </Providers>,
  );
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fillValid = () => {
  type("Family name", "Cola");
  type("Family price", "2.00"); // required (SA-606i)
  type("Variant 1 name", "Cherry");
  type("Variant 1 price", "1.50");
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create family" }));
const reject = (status: number, data: object) =>
  post.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue({ data: { available: true } });
});

describe("CreateFamilyModal", () => {
  it("opens with one blank variant row and the family fields", () => {
    mount();
    expect(screen.getByLabelText("Family name")).toBeInTheDocument();
    expect(screen.getByLabelText("Variant 1 name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Variant 2 name")).toBeNull();
  });

  it("invalid form: inline messages, NO request", () => {
    mount();
    submit();
    expect(screen.getByText("Enter a family name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a price.")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("duplicates inside the grid block submit before any request", () => {
    mount();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    type("Variant 2 name", "cherry");
    type("Variant 2 price", "1");
    submit();
    expect(screen.getAllByText("Appears more than once.")).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  it("valid submit: POST /products/families with the exact body (copy family price on), then opens the family", async () => {
    post.mockResolvedValueOnce({
      data: { family: { id: "fam1", name: "Cola" }, variants: [{ id: "v1" }] },
    });
    mount();
    fillValid();
    type("Family price", "2.00");
    type("Variant 1 SKU", " CH-1 ");
    fireEvent.click(screen.getByLabelText(/Copy the family price onto the variants/));
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/products/families", {
      family: { name: "Cola", pricePerUnit: "2.00" },
      variants: [{ name: "Cherry", sku: "CH-1", pricePerUnit: "1.50" }],
      copyFamilyPrice: true,
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/products/fam1"));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Family created", variant: "success" }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("409 FAMILY_ROWS_CONFLICT: EVERY conflicting cell is marked at once, nothing was written, no toast, no server text", async () => {
    reject(409, {
      code: "FAMILY_ROWS_CONFLICT",
      message: "RAW SERVER TEXT",
      rows: [
        { row: 0, field: "sku", value: "CH-1", reason: "CODE_TAKEN", conflictProductId: "h1" },
        { row: 1, field: "name", value: "Lime", reason: "NAME_TAKEN", conflictProductId: "h2" },
        {
          row: "family",
          field: "name",
          value: "Cola",
          reason: "NAME_TAKEN",
          conflictProductId: "h3",
        },
      ],
    });
    mount();
    fillValid();
    type("Variant 1 SKU", "CH-1");
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    type("Variant 2 name", "Lime");
    type("Variant 2 price", "1");
    submit();
    expect(
      await screen.findByText(`The SKU "CH-1" is already used by another product.`),
    ).toBeInTheDocument();
    expect(screen.getAllByText(`A product named "Lime" already exists.`)).toHaveLength(1);
    expect(screen.getByText(`A product named "Cola" already exists.`)).toBeInTheDocument();
    expect(
      screen.getByText("Nothing was saved. Fix the 3 marked cells and try again."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View product" })).toHaveLength(2); // the variant cells
    expect(toast).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/RAW SERVER TEXT/);
    expect(push).not.toHaveBeenCalled();
    // fixing a cell clears ITS message only
    type("Variant 1 SKU", "CH-2");
    expect(screen.queryByText(`The SKU "CH-1" is already used by another product.`)).toBeNull();
    expect(screen.getByText(`A product named "Lime" already exists.`)).toBeInTheDocument();
  });

  it("any other failure: exactly ONE fixed toast (the global raw-message toast is opted out), dialog stays open", async () => {
    reject(500, { message: "SQL exploded" });
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Couldn't create the family. Please try again.",
      variant: "error",
    });
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/SQL exploded/);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Family name")).toHaveValue("Cola"); // nothing lost
  });

  it("advisory availability: leaving a taken SKU shows a heads-up with the holder link; the write stays the authority", async () => {
    get.mockResolvedValueOnce({
      data: { available: false, takenBy: { productId: "h9", field: "sku" } },
    });
    mount();
    fillValid();
    type("Variant 1 SKU", "CH-1");
    fireEvent.blur(screen.getByLabelText("Variant 1 SKU"));
    expect(
      await screen.findByText(`The SKU "CH-1" is already used by another product.`),
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/products/sku-available", { params: { code: "CH-1" } });
    expect(screen.getByRole("link", { name: "View product" })).toHaveAttribute(
      "href",
      "/products/h9",
    );
    // submit is NOT blocked by an advisory answer
    post.mockResolvedValueOnce({ data: { family: { id: "f", name: "Cola" }, variants: [] } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
  });

  it("a slow availability answer never lands on another row: removing the row (or editing the value) in flight drops it", async () => {
    let resolve!: (v: unknown) => void;
    get.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    mount();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    type("Variant 2 name", "Lime");
    type("Variant 1 SKU", "CH-1");
    fireEvent.blur(screen.getByLabelText("Variant 1 SKU")); // check starts for row 1's value
    fireEvent.click(screen.getByRole("button", { name: "Remove variant 1" })); // row 1 goes; Lime is now row 1
    resolve({ data: { available: false, takenBy: { productId: "h9", field: "sku" } } });
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/is already used by another product/)).toBeNull();
    expect(screen.getByLabelText("Variant 1 SKU")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("the close button is inert while a create is in flight (the result would be lost)", async () => {
    let resolve!: (v: unknown) => void;
    post.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    mount();
    fillValid();
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    resolve({ data: { family: { id: "f", name: "Cola" }, variants: [] } });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/products/f"));
  });

  it("a failed availability check is silent (advisory only)", async () => {
    get.mockRejectedValueOnce(new Error("Network Error"));
    mount();
    type("Variant 1 SKU", "X-1");
    fireEvent.blur(screen.getByLabelText("Variant 1 SKU"));
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(toast).not.toHaveBeenCalled();
  });

  it("B1: 'Copy the family price' is disabled (with the reason) until a family price is entered; clearing it unticks", () => {
    mount();
    const copy = screen.getByLabelText(/Copy the family price onto the variants/);
    expect(copy).toBeDisabled();
    expect(
      screen.getByText("Enter a family price to copy it onto the variants."),
    ).toBeInTheDocument();
    type("Family price", "2.00");
    expect(copy).toBeEnabled();
    expect(screen.queryByText("Enter a family price to copy it onto the variants.")).toBeNull();
    fireEvent.click(copy);
    expect(copy).toBeChecked();
    type("Family price", "");
    expect(copy).not.toBeChecked();
    expect(copy).toBeDisabled();
  });

  it("SA-606i: a blank family price is REFUSED with 'Enter the family price.' and nothing is posted (no $0.00 family)", async () => {
    mount();
    fillValid();
    type("Family price", "");
    expect(screen.getByLabelText(/Copy the family price onto the variants/)).toBeDisabled();
    submit();
    expect(await screen.findByText("Enter the family price.")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("the create request ALWAYS carries the trimmed family price", async () => {
    post.mockResolvedValueOnce({
      data: { family: { id: "fam1", name: "Cola" }, variants: [{ id: "v1" }] },
    });
    mount();
    fillValid();
    type("Family price", " 3.25 ");
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].family).toMatchObject({ pricePerUnit: "3.25" });
  });

  it("blank cost hint is visible (SA-606g: blank = inherits the family cost)", () => {
    mount();
    expect(screen.getByText(/Leave cost blank to use the family cost\./)).toBeInTheDocument();
  });

  it("B1: a zero family price with copy TICKED is refused inline and nothing is posted; the server's FAMILY_COPY_PRICE_REQUIRED shows the same fixed copy on the price field, never the generic toast", async () => {
    mount();
    fillValid();
    type("Family price", "0.00");
    fireEvent.click(screen.getByLabelText(/Copy the family price onto the variants/));
    submit();
    expect(
      await screen.findByText("Enter the family price to copy it onto the variants."),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("B1: the coded 400 FAMILY_COPY_PRICE_REQUIRED maps to the fixed price copy (no generic toast)", async () => {
    reject(400, { code: "FAMILY_COPY_PRICE_REQUIRED" });
    mount();
    fillValid();
    type("Family price", "2.00");
    fireEvent.click(screen.getByLabelText(/Copy the family price onto the variants/));
    submit();
    expect(
      await screen.findByText("Enter the family price to copy it onto the variants."),
    ).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't create the family. Please try again." }),
    );
  });

  it("(a) TEXT_CELL_FORMULA_LEAD on a name -> the FIELD error under the family name (fixed copy), not the generic toast", async () => {
    reject(400, { code: "TEXT_CELL_FORMULA_LEAD", field: "productName" });
    mount();
    fillValid();
    submit();
    expect(
      await screen.findByText("Product name can't start with =, +, -, @ or a tab/line break."),
    ).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't create the family. Please try again." }),
    );
  });

  it("(b) the request carries the trimmed price: ' 12.50 ' is posted as '12.50'", async () => {
    post.mockResolvedValueOnce({
      data: { family: { id: "fam1", name: "Cola" }, variants: [{ id: "v1" }] },
    });
    mount();
    fillValid();
    type("Family price", " 12.50 ");
    submit();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][1].family.pricePerUnit).toBe("12.50");
  });
});
