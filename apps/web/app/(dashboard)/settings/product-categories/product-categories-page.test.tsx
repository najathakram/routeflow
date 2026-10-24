import * as React from "react";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import ProductCategoriesPage from "./page";

const createMutate = jest.fn();
const updateMutate = jest.fn();
const useCategories = jest.fn();
const toast = jest.fn();
let role = "TENANT_ADMIN";
let categories: unknown[] = [];
let isError = false;

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/product-labels", () => ({
  useProductCategories: (archived: boolean) => {
    useCategories(archived);
    return { data: categories, isError };
  },
  useCreateProductCategory: () => ({ mutate: createMutate, isPending: false }),
  useUpdateProductCategory: () => ({ mutate: updateMutate, isPending: false }),
}));

const cat = (over = {}) => ({
  id: "c1",
  name: "Alcohol",
  archivedAt: null,
  productCount: 3,
  activeRestrictionCount: 0,
  ...over,
});
const render = () => renderWithProviders(<ProductCategoriesPage />);
const click = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  jest.clearAllMocks();
  role = "TENANT_ADMIN";
  categories = [];
  isError = false;
});

describe("Product labels page", () => {
  it("empty state, and an error state that never claims 'no labels'", () => {
    const { unmount } = render();
    expect(screen.getByText(/no labels yet/i)).toBeInTheDocument();
    unmount();
    isError = true;
    render();
    expect(screen.getByText(/couldn.t load labels/i)).toBeInTheDocument();
    expect(screen.queryByText(/no labels yet/i)).toBeNull();
  });

  it("an API error raises NO page-level toast (the global mutation handler shows it once)", () => {
    render();
    fireEvent.change(screen.getByLabelText("New label name"), { target: { value: "THC" } });
    click(/add label/i);
    const opts = createMutate.mock.calls[0][1];
    opts.onError?.({
      response: { status: 409, data: { message: "A category named THC already exists." } },
    });
    expect(toast).not.toHaveBeenCalled(); // no error toast from the page
    opts.onSuccess?.(); // a success still gets exactly one confirmation
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "success" }));
  });

  it("lists labels with product counts and an active-rules badge", () => {
    categories = [
      cat({ activeRestrictionCount: 2 }),
      cat({ id: "c2", name: "THC", productCount: 1 }),
    ];
    render();
    expect(screen.getByText("3 products")).toBeInTheDocument();
    expect(screen.getByText("1 product")).toBeInTheDocument();
    expect(screen.getByText("2 active rules")).toBeInTheDocument();
  });

  it("adds a trimmed label and ignores a blank one", () => {
    render();
    expect(screen.getByRole("button", { name: /add label/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New label name"), { target: { value: "  THC  " } });
    click(/add label/i);
    expect(createMutate).toHaveBeenCalledWith({ name: "THC" }, expect.any(Object));
  });

  it("renames on Enter and archives", () => {
    categories = [cat()];
    render();
    click(/rename/i);
    const input = screen.getByLabelText("Rename Alcohol");
    fireEvent.change(input, { target: { value: "Spirits" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "c1", data: { name: "Spirits" } },
      expect.any(Object),
    );
    click(/cancel rename/i); // the mocked mutation never fires onSuccess
    click(/archive/i);
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "c1", data: { archived: true } },
      expect.any(Object),
    );
  });

  it("restores an archived label and can ask for archived rows", () => {
    categories = [cat({ archivedAt: "2026-09-19T00:00:00.000Z" })];
    render();
    click(/restore/i);
    expect(updateMutate).toHaveBeenCalledWith(
      { id: "c1", data: { archived: false } },
      expect.any(Object),
    );
    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(useCategories).toHaveBeenLastCalledWith(true);
  });

  it("each label row has Limit in portal… and opens the dialog scoped to that category (C, spec §1)", () => {
    categories = [cat({ name: "Vapes" }), cat({ id: "c2", name: "Old", archivedAt: "2026-01-01" })];
    render();
    // an archived label cannot be limited
    expect(screen.getAllByTestId("category-limit-in-portal")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("category-limit-in-portal"));
    expect(screen.getByText("Limit “Vapes” in your portal")).toBeInTheDocument();
  });

  it("is read-only for a non-admin", () => {
    role = "OPERATOR";
    categories = [cat()];
    render();
    expect(screen.getByText(/only a workspace admin/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("New label name")).toBeNull();
    expect(screen.queryByRole("button", { name: /rename|archive/i })).toBeNull();
  });
});
