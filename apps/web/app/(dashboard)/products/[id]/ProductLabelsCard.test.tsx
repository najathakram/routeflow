import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductLabelsCard } from "./ProductLabelsCard";

const setMutate = jest.fn();
const toast = jest.fn();
const removeMutate = jest.fn();
let role = "TENANT_ADMIN";
let labels: any;

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api/product-labels", () => ({
  useProductCategories: () => ({
    data: ["Alcohol", "THC"].map((name, i) => ({ id: `c${i + 1}`, name })),
  }),
  useProductLabels: () => ({ data: labels }),
  useSetProductLabel: () => ({ mutate: setMutate, isPending: false }),
  useRemoveProductLabel: () => ({ mutate: removeMutate, isPending: false }),
}));

const inh = (id = "c1", n = "Alcohol") => ({
  categoryId: id,
  categoryName: n,
  categoryArchived: false,
});
const own = (over = {}) => ({
  id: "l1",
  categoryId: "c1",
  categoryName: "Alcohol",
  categoryArchived: false,
  mode: "INCLUDE",
  optOutActive: null,
  ...over,
});
const view = (over = {}) => ({
  productId: "v1",
  parentProductId: "p1",
  ancestryResolvable: true,
  own: [],
  inherited: [inh()],
  ...over,
});
const render = () => renderWithProviders(<ProductLabelsCard productId="v1" />);
const click = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
  labels = view();
});

describe("ProductLabelsCard", () => {
  it("opting out needs a reason, sends it trimmed, and says a parent-product rule still applies", () => {
    render();
    click("Opt out");
    expect(screen.getByRole("button", { name: "Confirm opt-out" })).toBeDisabled();
    expect(
      screen.getByText(/targets the parent product itself still applies/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/why does this variant opt out/i), {
      target: { value: "  THC-free " },
    });
    click("Confirm opt-out");
    expect(setMutate).toHaveBeenCalledWith(
      { categoryId: "c1", mode: "EXCLUDE", reason: "THC-free" },
      expect.any(Object),
    );
  });

  it("an ACTIVE opt-out reads as opted out and can be undone", () => {
    labels = view({ own: [own({ mode: "EXCLUDE", reason: "x", optOutActive: true })] });
    render();
    expect(screen.getByText("opted out")).toBeInTheDocument();
    click("Undo opt-out");
    expect(removeMutate).toHaveBeenCalledWith({ categoryId: "c1" }, expect.any(Object));
  });

  it("an INACTIVE opt-out (variant was moved) does not read as opted out and offers to re-record it", () => {
    labels = view({ own: [own({ mode: "EXCLUDE", reason: "x", optOutActive: false })] });
    render();
    expect(screen.getByText(/opt-out inactive: parent changed/i)).toBeInTheDocument();
    expect(screen.queryByText("opted out")).toBeNull();
    expect(screen.getByRole("button", { name: "Opt out again" })).toBeInTheDocument();
  });

  it("warns when the parent chain can't be resolved", () => {
    labels = view({ ancestryResolvable: false });
    render();
    expect(screen.getByRole("alert")).toHaveTextContent(/can.t be resolved/i);
  });

  it("adds an INCLUDE label from the untaken ones and removes one", () => {
    labels = view({ parentProductId: null, inherited: [], own: [own()] });
    render();
    const select = screen.getByLabelText("Add a label") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual(["Add a label…", "THC"]);
    fireEvent.change(select, { target: { value: "c2" } });
    click("Add");
    expect(setMutate).toHaveBeenCalledWith(
      { categoryId: "c2", mode: "INCLUDE" },
      expect.any(Object),
    );
    click("Remove Alcohol");
    expect(removeMutate).toHaveBeenCalledWith({ categoryId: "c1" }, expect.any(Object));
  });

  it("an API error raises NO page-level toast (the global mutation handler shows it once)", () => {
    render();
    click("Opt out");
    fireEvent.change(screen.getByLabelText(/why does this variant opt out/i), {
      target: { value: "x" },
    });
    click("Confirm opt-out");
    const opts = setMutate.mock.calls[0][1];
    opts.onError?.({
      response: { status: 400, data: { message: "The parent product does not carry this label." } },
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("is read-only for a non-admin", () => {
    role = "OPERATOR";
    render();
    expect(screen.getByText("Alcohol")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add a label")).toBeNull();
    expect(screen.queryByRole("button", { name: /opt out|remove/i })).toBeNull();
  });
});
