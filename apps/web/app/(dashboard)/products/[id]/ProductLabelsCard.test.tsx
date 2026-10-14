import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductLabelsCard } from "./ProductLabelsCard";

const setMutate = jest.fn();
const toast = jest.fn();
const removeMutate = jest.fn();
let role = "TENANT_ADMIN";
let labels: any;
let categoriesFailed = false;

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
// The card renders PortalLimitsRow, whose "View rule" toast action routes (row 509 PR5).
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api/product-labels", () => ({
  useProductCategories: () => ({
    data: categoriesFailed
      ? undefined
      : ["Alcohol", "THC"].map((name, i) => ({ id: `c${i + 1}`, name })),
    isError: categoriesFailed,
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
  categoriesFailed = false;
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

  it("an INCLUDE the category-text sync added renders like any other own label, with a Remove for staff and none for a non-staff role", () => {
    labels = view({
      parentProductId: null,
      inherited: [],
      own: [
        own({
          id: "auto1",
          categoryId: "c2",
          categoryName: "THC",
          createdById: "u1",
          createdByName: "olivia",
        }),
      ],
    });
    render();
    const list = screen.getByRole("list", { name: "Labels on this product" });
    expect(list).toHaveTextContent("THC");
    expect(screen.getByRole("button", { name: "Remove THC" })).toBeInTheDocument();
    role = "DRIVER";
    renderWithProviders(<ProductLabelsCard productId="v1" />);
    expect(screen.getAllByRole("list", { name: "Labels on this product" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Remove THC" })).toHaveLength(1);
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

  it("a failed write raises NO page-level toast (the global mutation handler shows it once)", () => {
    // Fail the way react-query does: run whichever failure callbacks the component supplied. If the
    // component ever adds its own onError toast, this turns red.
    const err = {
      response: { status: 400, data: { message: "Parent does not carry this label." } },
    };
    setMutate.mockImplementation((_v, opts) => {
      opts?.onError?.(err);
      opts?.onSettled?.(undefined, err);
    });
    render();
    click("Opt out");
    fireEvent.change(screen.getByLabelText(/why does this variant opt out/i), {
      target: { value: "x" },
    });
    click("Confirm opt-out");
    expect(setMutate).toHaveBeenCalled();
    expect(Object.keys(setMutate.mock.calls[0][1])).toEqual(["onSuccess"]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("undoing an opt-out says the label applies again, never 'removed'; removing a label says removed", () => {
    removeMutate.mockImplementation((_v, opts) => opts.onSuccess());
    labels = view({ own: [own({ mode: "EXCLUDE", reason: "x", optOutActive: true })] });
    render();
    click("Undo opt-out");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Alcohol applies to this variant again" }),
    );
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Alcohol removed" }));
  });

  it("removing an own label toasts 'removed'", () => {
    removeMutate.mockImplementation((_v, opts) => opts.onSuccess());
    labels = view({ parentProductId: null, inherited: [], own: [own()] });
    render();
    click("Remove Alcohol");
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Alcohol removed" }));
  });

  it("a failed categories fetch says so, never 'No more labels to add'", () => {
    categoriesFailed = true;
    render();
    const select = screen.getByLabelText("Add a label") as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select.options[0].text).toBe("Couldn't load labels to add");
    expect(screen.queryByText(/No more labels to add/)).toBeNull();
  });

  it.each(["DRIVER", "CUSTOMER"])("is read-only for %s", (r) => {
    role = r;
    render();
    expect(screen.getByText("Alcohol")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add a label")).toBeNull();
    expect(screen.queryByRole("button", { name: /opt out|remove/i })).toBeNull();
  });

  describe("owner ruling 2026-10-14: operators write labels, except a federal-covered one", () => {
    const HINT = "Only an account admin can change (or lift) a federal rule.";

    it("an operator adds, removes and opts out of labels no federal rule covers, with no hint", () => {
      role = "OPERATOR";
      labels = view({ own: [own({ id: "l2", categoryId: "c2", categoryName: "THC" })] });
      render();
      expect(screen.getByRole("button", { name: "Remove THC" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Opt out" })).toBeEnabled();
      expect(screen.getByLabelText("Add a label")).toBeEnabled();
      expect(screen.queryByText(HINT)).toBeNull();
    });

    it("an operator sees a federal-covered label's controls DISABLED, pointing at the one visible hint", () => {
      role = "OPERATOR";
      labels = view({
        own: [own({ id: "l2", categoryId: "c2", categoryName: "THC" })],
        federalCategoryIds: ["c1", "c2"],
      });
      render();
      const remove = screen.getByRole("button", { name: "Remove THC" });
      const optOut = screen.getByRole("button", { name: "Opt out" });
      for (const b of [remove, optOut]) {
        expect(b).toBeDisabled();
        const hint = document.getElementById(b.getAttribute("aria-describedby") as string);
        expect(hint).toHaveTextContent(HINT);
        expect(hint).toBeVisible();
      }
      expect(screen.getAllByText(HINT)).toHaveLength(1);
      fireEvent.click(remove);
      expect(remove).toBeDisabled();
    });

    it.each(["TENANT_ADMIN", "SUPER_ADMIN"])(
      "%s writes a federal-covered label: enabled, no hint",
      (r) => {
        role = r;
        labels = view({
          own: [own({ id: "l2", categoryId: "c2", categoryName: "THC" })],
          federalCategoryIds: ["c1", "c2"],
        });
        render();
        expect(screen.getByRole("button", { name: "Remove THC" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Opt out" })).toBeEnabled();
        expect(screen.queryByText(HINT)).toBeNull();
      },
    );
  });
});
