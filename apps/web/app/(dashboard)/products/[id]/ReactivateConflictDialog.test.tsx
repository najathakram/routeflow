import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactivateConflictDialog } from "./ReactivateConflictDialog";
import type { ReactivationRefusal } from "@/lib/product-reactivation-refusal";

const checkCodeAvailable = jest.fn();
jest.mock("@/lib/api/product-families", () => ({
  ...jest.requireActual("@/lib/api/product-families"),
  checkCodeAvailable: (...a: unknown[]) => checkCodeAvailable(...a),
}));

const holder = (over: Record<string, unknown> = {}) => ({
  productId: "h1",
  productName: "Cola 6pk",
  field: "sku",
  value: "COLA-6",
  line: `The SKU "COLA-6" is now used by Cola 6pk.`,
  blocked: false,
  ...over,
});

const holders = (over: Record<string, unknown> = {}) => ({
  kind: "HOLDERS" as const,
  holders: [holder()],
  holderIds: ["h1"],
  canResolve: true,
  ...over,
});

function setup(refusal: ReactivationRefusal | null) {
  const onClose = jest.fn();
  const onResolve = jest.fn();
  const onResolveWithCodes = jest.fn();
  const onRetry = jest.fn();
  render(
    <ReactivateConflictDialog
      refusal={refusal}
      productName="Cola 12pk"
      onClose={onClose}
      onResolve={onResolve}
      onResolveWithCodes={onResolveWithCodes}
      onRetry={onRetry}
    />,
  );
  return { onClose, onResolve, onResolveWithCodes, onRetry };
}

const footerLabels = () => screen.getAllByRole("button").map((b) => b.textContent?.trim() ?? "");

beforeEach(() => {
  jest.clearAllMocks();
  checkCodeAvailable.mockResolvedValue({ available: true });
});

describe("ReactivateConflictDialog", () => {
  it("renders nothing when there is no refusal", () => {
    setup(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("one SKU holder -> Close, Use a new code instead, the danger resolve, in that order", () => {
    const { onResolve } = setup(holders());
    const labels = footerLabels().filter((t) =>
      ["Close", "Use a new code instead", 'Deactivate "Cola 6pk" and reactivate this'].includes(t),
    );
    expect(labels).toEqual([
      "Close",
      "Use a new code instead",
      'Deactivate "Cola 6pk" and reactivate this',
    ]);
    expect(screen.getByText(/The SKU "COLA-6" is now used by/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reactivate-resolve"));
    expect(onResolve).toHaveBeenCalledWith(["h1"]);
  });

  it("a blocked holder -> no danger resolve, but the new-code button and the blocked sentence", () => {
    setup(
      holders({
        holders: [holder({ blocked: true, productName: "Cola family" })],
        canResolve: false,
      }),
    );
    expect(screen.queryByTestId("reactivate-resolve")).toBeNull();
    expect(screen.getByRole("button", { name: "Use a new code instead" })).toBeInTheDocument();
    expect(
      screen.getByText(/has active variants, so it can't be deactivated from here/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Open it to change the code\./)).toBeInTheDocument();
  });

  it("a name holder -> no new-code button", () => {
    setup(
      holders({
        holders: [holder({ field: "name", value: "Cola 6pk", line: "name line" })],
      }),
    );
    expect(screen.queryByRole("button", { name: "Use a new code instead" })).toBeNull();
    expect(screen.getByTestId("reactivate-resolve")).toBeInTheDocument();
  });

  it("clicking Use a new code instead opens the step with New SKU focused; submit needs a different, non-empty code", () => {
    setup(holders());
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    expect(screen.getByText("Choose a new code")).toBeInTheDocument();
    const input = screen.getByLabelText("New SKU");
    expect(input).toHaveFocus();
    const submit = screen.getByRole("button", { name: "Reactivate with new code" });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "COLA-6" } });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "NEW-1" } });
    expect(submit).toBeEnabled();
  });

  it("the step names the product and the holder who keeps its code", () => {
    setup(holders());
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    expect(
      screen.getByText(
        'Cola 12pk will be reactivated with the new code. "Cola 6pk" keeps its own.',
      ),
    ).toBeInTheDocument();
  });

  it("several holders -> 'The other products keep their own codes.'", () => {
    setup(
      holders({
        holders: [holder(), holder({ productId: "h2", productName: "Other" })],
        holderIds: ["h1", "h2"],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    expect(
      screen.getByText(
        "Cola 12pk will be reactivated with the new code. The other products keep their own codes.",
      ),
    ).toBeInTheDocument();
  });

  it("submit -> onResolveWithCodes({sku}) once, never onResolve", () => {
    const { onResolve, onResolveWithCodes } = setup(holders());
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "NEW-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Reactivate with new code" }));
    expect(onResolveWithCodes).toHaveBeenCalledTimes(1);
    expect(onResolveWithCodes).toHaveBeenCalledWith({ sku: "NEW-1" });
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("Back returns to the choose step", () => {
    setup(holders());
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "NEW-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByText("Choose a new code")).toBeNull();
    expect(screen.getByTestId("reactivate-resolve")).toBeInTheDocument();
    // Back keeps what was typed
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    expect(screen.getByLabelText("New SKU")).toHaveValue("NEW-1");
  });

  it("links the holder once per holder", () => {
    setup(
      holders({
        holders: [holder(), holder({ field: "barcode", value: "B1" })],
      }),
    );
    const links = screen.getAllByRole("link", { name: "Cola 6pk" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/products/h1");
  });

  it("sku + barcode clashes need both inputs", () => {
    const { onResolveWithCodes } = setup(
      holders({
        holders: [
          holder(),
          holder({ productId: "h2", productName: "Other", field: "barcode", value: "B1" }),
        ],
        holderIds: ["h1", "h2"],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    const submit = screen.getByRole("button", { name: "Reactivate with new code" });
    fireEvent.change(screen.getByLabelText("New SKU"), { target: { value: "NEW-1" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("New barcode"), { target: { value: "NEWB" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onResolveWithCodes).toHaveBeenCalledWith({ sku: "NEW-1", barcode: "NEWB" });
  });

  it("on blur: an available code says so; a taken one names the holder", async () => {
    setup(holders());
    fireEvent.click(screen.getByRole("button", { name: "Use a new code instead" }));
    const input = screen.getByLabelText("New SKU");
    fireEvent.change(input, { target: { value: "NEW-1" } });
    fireEvent.blur(input);
    expect(await screen.findByText("NEW-1 is available.")).toBeInTheDocument();
    checkCodeAvailable.mockResolvedValue({
      available: false,
      takenBy: { productId: "h1", field: "sku" },
    });
    fireEvent.change(input, { target: { value: "COLA-7" } });
    fireEvent.blur(input);
    expect(await screen.findByText("COLA-7 is already used by Cola 6pk.")).toBeInTheDocument();
    expect(checkCodeAvailable).toHaveBeenCalledWith("COLA-7");
  });

  it("cancel/close does not resolve", () => {
    const { onClose, onResolve } = setup(holders());
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("two holders -> every line, both ids in one resolve", () => {
    const { onResolve } = setup(
      holders({
        holders: [
          holder({ productName: "A", line: "line A" }),
          holder({ productId: "h2", productName: "B", line: "line B" }),
        ],
        holderIds: ["h1", "h2"],
      }),
    );
    fireEvent.click(screen.getByTestId("reactivate-resolve"));
    expect(onResolve).toHaveBeenCalledWith(["h1", "h2"]);
    expect(screen.getByRole("link", { name: "A" })).toHaveAttribute("href", "/products/h1");
    expect(screen.getByRole("link", { name: "B" })).toHaveAttribute("href", "/products/h2");
  });

  it("a hostile product name is text, not markup", () => {
    const name = `<img src=x onerror=alert(1)>`;
    setup(holders({ holders: [holder({ productName: name })] }));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name })).toBeInTheDocument();
  });

  it("retry kind -> a retry prompt, no holder list", () => {
    const { onRetry } = setup({ kind: "RETRY" });
    fireEvent.click(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByTestId("reactivate-resolve")).toBeNull();
  });

  it("a name clash with no productId: its line shows, but no link, no resolve, no new code", () => {
    setup({
      kind: "HOLDERS",
      holders: [
        {
          productId: "",
          productName: "",
          line: "name line",
          blocked: false,
          field: "name",
          value: "x",
        },
      ],
      holderIds: [],
      canResolve: false,
    });
    expect(screen.getByText("name line")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByTestId("reactivate-resolve")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use a new code instead" })).toBeNull();
  });
});
