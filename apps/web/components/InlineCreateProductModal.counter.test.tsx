import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Modal } from "@routeflow/ui/web";
import { InlineCreateProductModal } from "./InlineCreateProductModal";

/**
 * W-1042 (SA-1062 MUSTs 9 and 14a): the new-item window at the counter. `requirePrice` keeps Save off until the price is
 * above $0 (a blank price used to go out as "0" and sell a $0 line). The root carries `data-scan-pause` so the counter
 * holds scans and focus while it is open; it is NOT a dialog role, because the window also sits inside the order builder's
 * Modal and a nested role would break that Modal's Unit and Category picks (R13b).
 */
const createMutate = jest.fn();
let categories: string[] = [];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useCreateProduct: () => ({ mutate: createMutate, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  useProductCategories: () => ({ data: categories }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), post: jest.fn() },
}));

function mount(props: Partial<React.ComponentProps<typeof InlineCreateProductModal>> = {}) {
  const onClose = jest.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InlineCreateProductModal isOpen onClose={onClose} onCreated={jest.fn()} {...props} />
    </QueryClientProvider>,
  );
  return { onClose };
}

const save = () => screen.getByRole("button", { name: /create product/i }) as HTMLButtonElement;
const form = () => save().closest("form")!;
const price = () => screen.getByPlaceholderText("0.00") as HTMLInputElement;
const PRICE_HINT = "Enter a price to sell this item.";

beforeEach(() => {
  createMutate.mockReset();
  categories = [];
});

describe("W-1042 MUST 9: requirePrice", () => {
  it("R5: a blank price leaves Save disabled and says why", () => {
    mount({ requirePrice: true, initialName: "Fresh Pie" });
    expect(save().disabled).toBe(true);
    expect(screen.queryByText(PRICE_HINT)).not.toBeNull();
  });

  it("R5: $0 is not a price; the first cent turns Save on and the line goes", () => {
    mount({ requirePrice: true, initialName: "Fresh Pie" });
    fireEvent.change(price(), { target: { value: "0" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(price(), { target: { value: "0.01" } });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(PRICE_HINT)).toBeNull();
  });

  it("R5: a submit with no price sends nothing (Enter in a field cannot get round the button)", () => {
    mount({ requirePrice: true, initialName: "Fresh Pie" });
    fireEvent.submit(form());
    expect(createMutate).toHaveBeenCalledTimes(0);
  });

  it("guard: without requirePrice (the builder's mounts) a blank price still goes out as 0 and Save is on", () => {
    mount({ initialName: "Fresh Pie" });
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(PRICE_HINT)).toBeNull();
    fireEvent.submit(form());
    expect(createMutate.mock.calls[0][0]).toMatchObject({ pricePerUnit: "0" });
  });
});

describe("W-1042 MUST 14a: the counter holds scans while the window is open", () => {
  it("the root carries data-scan-pause while open", () => {
    mount({ initialName: "Fresh Pie" });
    expect(document.querySelector("[data-scan-pause]")).not.toBeNull();
  });

  it("the attribute goes with the window", () => {
    mount({ isOpen: false });
    expect(document.querySelector("[data-scan-pause]")).toBeNull();
  });

  it("guard: the root is NOT a dialog role (the builder's Modal owns its Unit and Category lists)", () => {
    mount({ initialName: "Fresh Pie" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("W-1042 R13b guard: inside the order builder's Modal the Unit and Category picks land", () => {
  it("picking a Unit and a Category keeps the order open and sets both", async () => {
    categories = ["Bakery"];
    const user = userEvent.setup({ pointerEventsCheck: 0 }); // Radix sets body pointer-events; the list is portalled
    const onCloseOrder = jest.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Modal open onClose={onCloseOrder} title="New order">
          <InlineCreateProductModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />
        </Modal>
      </QueryClientProvider>,
    );
    const unit = screen.getByPlaceholderText("e.g. case, kg, unit") as HTMLInputElement;
    await user.click(unit);
    await user.click(
      await within(await screen.findByRole("option", { name: "case" })).findByRole("button"),
    );
    expect(unit.value).toBe("case");
    const category = screen.getByPlaceholderText("e.g. Bakery") as HTMLInputElement;
    await user.click(category);
    await user.click(
      await within(await screen.findByRole("option", { name: "Bakery" })).findByRole("button"),
    );
    expect(category.value).toBe("Bakery");
    expect(onCloseOrder).not.toHaveBeenCalled();
  });
});
