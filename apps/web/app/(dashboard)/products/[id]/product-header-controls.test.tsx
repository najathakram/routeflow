import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProductHeaderControls } from "./ProductHeaderControls";

let role = "OPERATOR";
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { role } }),
}));

const flow = () => ({ start: jest.fn(), askDeactivate: jest.fn(), isPending: false });

function setup(over: { isActive?: boolean } = {}) {
  const reactivateFlow = flow();
  const onRequestDelete = jest.fn();
  render(
    <ProductHeaderControls
      product={{
        id: "p1",
        name: "Cola 12pk",
        isActive: over.isActive ?? true,
        parentProductId: null,
        kind: "SIMPLE",
      }}
      reactivateFlow={reactivateFlow}
      hasTobaccoAddon={false}
      isTobacco={false}
      tobaccoLoading={false}
      onToggleTobacco={jest.fn()}
      onMakeVariant={jest.fn()}
      onRequestDelete={onRequestDelete}
    />,
  );
  return { reactivateFlow, onRequestDelete };
}

beforeEach(() => {
  role = "OPERATOR";
});

describe("ProductHeaderControls (VU-2)", () => {
  it("an inactive product offers Reactivate, never Activate", () => {
    setup({ isActive: false });
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
  });

  it("an active product offers Deactivate", () => {
    setup();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reactivate" })).toBeNull();
  });

  it("Reactivate starts the same flow; Deactivate asks first (unchanged)", () => {
    const a = setup({ isActive: false });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate" }));
    expect(a.reactivateFlow.start).toHaveBeenCalledWith("p1", "product", "Cola 12pk");
    expect(a.reactivateFlow.askDeactivate).not.toHaveBeenCalled();
  });

  it("Deactivate opens the deactivate confirm path", () => {
    const a = setup();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(a.reactivateFlow.askDeactivate).toHaveBeenCalledWith("p1", "Cola 12pk");
    expect(a.reactivateFlow.start).not.toHaveBeenCalled();
  });

  it("Delete is an OPERATOR control in the lighter danger-outline style", () => {
    setup();
    const del = screen.getByRole("button", { name: "Delete" });
    expect(del.className).toContain("border-danger/40");
    expect(del.className).toContain("text-danger");
    expect(del.className).not.toContain("bg-danger ");
  });

  it.each(["DRIVER", "CUSTOMER", "STAFF"])("Delete and Make variant of… are absent for %s", (r) => {
    role = r;
    setup();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make variant of…" })).toBeNull();
  });

  it.each(["OPERATOR", "TENANT_ADMIN"])(
    "owner ruling 2026-10-14: %s gets Delete and Make variant of…",
    (r) => {
      role = r;
      setup();
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Make variant of…" })).toBeEnabled();
    },
  );

  it("Delete asks the page to open its DeleteProductConfirm (no second dialog here)", () => {
    const { onRequestDelete } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("P-14: secondary actions are ghost; Delete sits apart behind a divider wrapper", () => {
    setup();
    const deactivate = screen.getByRole("button", { name: "Deactivate" });
    expect(deactivate.className).not.toMatch(/border-line-strong/); // not the secondary look
    expect(deactivate.className).toMatch(/text-ink-500/); // ghost
    const del = screen.getByRole("button", { name: "Delete" });
    const wrap = del.parentElement as HTMLElement;
    expect(wrap.className).toMatch(/sm:border-l/);
    expect(wrap.className).toMatch(/sm:ml-2/);
    expect(wrap.className).toMatch(/max-sm:basis-full/);
  });

  it("D1: below sm the Delete row starts at the leading edge, set apart by a hairline above", () => {
    setup();
    const wrap = screen.getByRole("button", { name: "Delete" }).parentElement as HTMLElement;
    expect(wrap.className).toMatch(/max-sm:justify-start/);
    expect(wrap.className).toMatch(/max-sm:border-t/);
    expect(wrap.className).toMatch(/max-sm:basis-full/);
    expect(wrap.className).not.toMatch(/max-sm:justify-end/);
  });
});
