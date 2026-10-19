import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { FamilyVariantsEditor } from "./FamilyVariantsEditor";

const toast = jest.fn();
const patch = jest.fn();
const get = jest.fn();
let role = "OPERATOR";
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { patch: (...a: unknown[]) => patch(...a), get: (...a: unknown[]) => get(...a) },
}));

const variants = [
  {
    id: "v1",
    name: "Cola Cherry",
    variantName: "Cherry",
    sku: "C-1",
    unitSku: null,
    barcode: null,
    unitsPerBox: 12,
    pricePerUnit: "1.50",
    standardCost: "0.80",
    isActive: true,
  },
  {
    id: "v2",
    name: "Cola Lime",
    variantName: "Lime",
    sku: null,
    unitSku: null,
    barcode: null,
    unitsPerBox: null,
    pricePerUnit: "1.50",
    standardCost: null,
    isActive: true,
  },
  {
    id: "v3",
    name: "Cola Old",
    variantName: "Old",
    sku: "OLD",
    pricePerUnit: "1",
    standardCost: null,
    isActive: false,
  },
];
const mount = () =>
  render(
    <Providers>
      <FamilyVariantsEditor familyId="fam1" variants={variants as any} />
    </Providers>,
  );
const edit = () => fireEvent.click(screen.getByRole("button", { name: "Edit variants" }));
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save variants" }));
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const reject = (status: number, data: object) =>
  patch.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  role = "OPERATOR";
  get.mockResolvedValue({ data: { available: true } });
});

describe("FamilyVariantsEditor", () => {
  it("read-only by default: the ACTIVE variants only (an inactive one is not a row)", () => {
    mount();
    expect(screen.getAllByText("Cherry").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Lime").length).toBeGreaterThan(0);
    expect(screen.queryByText("Old")).toBeNull();
    expect(screen.queryByLabelText("Variant 1 name")).toBeNull();
  });

  it.each([
    ["OPERATOR", true],
    ["TENANT_ADMIN", true],
    ["DRIVER", false],
  ])("role %s -> can edit: %s", (r, can) => {
    role = r;
    mount();
    expect(!!screen.queryByRole("button", { name: "Edit variants" })).toBe(can);
  });

  it("Save is disabled until something changed; Cancel discards edits", () => {
    mount();
    edit();
    expect(screen.getByRole("button", { name: "Save variants" })).toBeDisabled();
    type("Variant 1 price", "9.00");
    expect(screen.getByRole("button", { name: "Save variants" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Variant 1 price")).toBeNull();
    edit();
    expect(screen.getByLabelText("Variant 1 price")).toHaveValue("1.50");
  });

  it("one PATCH with changed fields only, a removed row as deactivate, a new row as add; then back to read-only", async () => {
    patch.mockResolvedValueOnce({ data: {} });
    mount();
    edit();
    type("Variant 1 price", "1.60"); // v1: price only
    fireEvent.click(screen.getByRole("button", { name: "Remove variant 2" })); // v2 deactivated
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    type("Variant 2 name", "Peach");
    type("Variant 2 price", "2.00");
    save();
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/products/fam1/variants", {
      update: [{ id: "v1", pricePerUnit: "1.60" }],
      deactivate: ["v2"],
      add: [{ name: "Peach", pricePerUnit: "2.00" }],
    });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Variants saved (1 added, 1 changed)",
          variant: "success",
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByLabelText("Variant 1 price")).toBeNull());
  });

  it("client validation blocks the request and marks the cell", () => {
    mount();
    edit();
    type("Variant 1 price", "abc");
    save();
    expect(screen.getByText("Enter a price like 1.50.")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("409 FAMILY_ROWS_CONFLICT: the request row is mapped back to the right grid cell (add rows first, then updates)", async () => {
    reject(409, {
      code: "FAMILY_ROWS_CONFLICT",
      message: "RAW SERVER TEXT",
      rows: [
        { row: 0, field: "name", value: "Peach", reason: "NAME_TAKEN", conflictProductId: "h1" }, // add[0]
        { row: 1, field: "sku", value: "NEW-SKU", reason: "CODE_TAKEN", conflictProductId: "h2" }, // update[0] = v1 (add.length 1 + 0)
      ],
    });
    mount();
    edit();
    type("Variant 1 SKU", "NEW-SKU"); // v1 sku changed -> update[0]
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    type("Variant 3 name", "Peach"); // the new row is grid row 3 (v1, v2, new)
    type("Variant 3 price", "2");
    save();
    expect(await screen.findByText(`A product named "Peach" already exists.`)).toBeInTheDocument();
    expect(
      screen.getByText(`The SKU "NEW-SKU" is already used by another product.`),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nothing was saved. Fix the 2 marked cells and try again."),
    ).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/RAW SERVER TEXT/);
    // edit mode stays open with the operator's work intact
    expect(screen.getByLabelText("Variant 3 name")).toHaveValue("Peach");
    // the marks sit on the RIGHT cells (identity mapping), not just the right words somewhere
    expect(screen.getByLabelText("Variant 3 name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Variant 1 SKU")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Variant 2 SKU")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("Cancel clears the error banner (it must not linger over the read-only grid)", async () => {
    reject(409, {
      code: "FAMILY_ROWS_CONFLICT",
      rows: [{ row: 0, field: "sku", value: "NEW", reason: "CODE_TAKEN" }],
    });
    mount();
    edit();
    type("Variant 1 SKU", "NEW");
    save();
    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Nothing was saved/)).toBeNull();
    edit();
    expect(screen.queryByText(/Nothing was saved/)).toBeNull();
  });

  it("the banner goes once every marked cell has been fixed", async () => {
    reject(409, {
      code: "FAMILY_ROWS_CONFLICT",
      rows: [{ row: 0, field: "sku", value: "NEW", reason: "CODE_TAKEN" }],
    });
    mount();
    edit();
    type("Variant 1 SKU", "NEW");
    save();
    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
    type("Variant 1 SKU", "OTHER");
    expect(screen.queryByText(/Nothing was saved/)).toBeNull();
  });

  it("price authority (mixed packs): a fixed explanation, not 'try again'; one toast", async () => {
    reject(409, { code: "FAMILY_PRICE_AUTHORITY", message: "RAW SERVER TEXT" });
    mount();
    edit();
    type("Variant 1 price", "3");
    save();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Prices are set on the family",
      description: "Change the family price to change its variants' prices.",
      variant: "error",
    });
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/RAW SERVER TEXT/);
  });

  it("more than 200 changes in one save: blocked client-side with a clear line, no request", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      name: `M${i}`,
      variantName: `M${i}`,
      pricePerUnit: "1.00",
      isActive: true,
    }));
    render(
      <Providers>
        <FamilyVariantsEditor familyId="fam1" variants={many as any} />
      </Providers>,
    );
    edit();
    // reprice 150 and replace 50 -> 250 request rows
    for (let i = 1; i <= 150; i++) type(`Variant ${i} price`, "2.00");
    for (let i = 151; i <= 200; i++)
      fireEvent.click(screen.getByRole("button", { name: "Remove variant 151" }));
    for (let i = 0; i < 50; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
      type(`Variant ${151 + i} name`, `New${i}`);
      type(`Variant ${151 + i} price`, "1");
    }
    save();
    expect(
      screen.getByText("A single save takes up to 200 changes. Save in smaller batches."),
    ).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("the cost hint is not shown while editing (a cleared cost is not sent, so it must not promise otherwise)", () => {
    mount();
    expect(screen.queryByText(/Leave cost blank/)).toBeNull();
    edit();
    expect(screen.queryByText(/Leave cost blank/)).toBeNull();
  });

  it("FAMILY_NOT_FOUND: one fixed toast, no server text", async () => {
    reject(404, { code: "FAMILY_NOT_FOUND", message: "RAW" });
    mount();
    edit();
    type("Variant 1 price", "3");
    save();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "This family no longer exists.",
      variant: "error",
    });
  });

  it("any other failure: exactly ONE fixed toast (global raw toast opted out)", async () => {
    reject(500, { message: "SQL exploded" });
    mount();
    edit();
    type("Variant 1 price", "3");
    save();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      title: "Couldn't save the variants. Please try again.",
      variant: "error",
    });
    expect(JSON.stringify(toast.mock.calls)).not.toMatch(/SQL exploded/);
  });

  it("B3: clearing a saved cost or units/case is a visible error and nothing is sent (no silent 'saved')", () => {
    mount();
    edit();
    type("Variant 1 cost", "");
    type("Variant 1 pieces per box", "");
    save();
    expect(screen.getAllByText("Can't be cleared once set. Enter a new value.")).toHaveLength(2);
    expect(patch).not.toHaveBeenCalled();
  });

  it("B4: a family with more than 200 saved variants is editable and a one-row change saves (the cap is on the REQUEST)", async () => {
    const many = Array.from({ length: 205 }, (_, i) => ({
      id: `m${i}`,
      name: `M${i}`,
      variantName: `M${i}`,
      pricePerUnit: "1.00",
      isActive: true,
    }));
    patch.mockResolvedValueOnce({ data: {} });
    render(
      <Providers>
        <FamilyVariantsEditor familyId="fam1" variants={many as any} />
      </Providers>,
    );
    edit();
    expect(screen.getByRole("button", { name: "Add variant" })).toBeEnabled();
    expect(screen.queryByText("A family takes up to 200 variants at a time.")).toBeNull();
    type("Variant 3 price", "2.00");
    save();
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/products/fam1/variants", {
      update: [{ id: "m2", pricePerUnit: "2.00" }],
    });
  });

  it("a conflict whose row cannot be matched to a cell still says so (never silent)", async () => {
    reject(409, {
      code: "FAMILY_ROWS_CONFLICT",
      rows: [{ row: 99, field: "sku", value: "X", reason: "CODE_TAKEN" }],
    });
    mount();
    edit();
    type("Variant 1 price", "3");
    save();
    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("FamilyVariantsEditor ?variant= (K13 F18)", () => {
  it("brings the variant named in the URL into view and marks it", () => {
    Element.prototype.scrollIntoView = jest.fn();
    window.history.pushState({}, "", "/products/fam?variant=v2");
    render(
      <Providers>
        <FamilyVariantsEditor familyId="fam" variants={variants as any} />
      </Providers>,
    );
    expect(screen.getByRole("link", { name: /Lime/ }).closest("tr")).toHaveAttribute(
      "data-focused-variant",
      "true",
    );
    window.history.pushState({}, "", "/");
  });
});
