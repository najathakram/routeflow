import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactivateConflictDialog } from "./ReactivateConflictDialog";
import type { ReactivationRefusal } from "@/lib/product-reactivation-refusal";

const holders = (over: Record<string, unknown> = {}) => ({
  kind: "HOLDERS" as const,
  holders: [
    {
      productId: "h1",
      productName: "Cola 6pk",
      line: `Can't reactivate: the SKU "COLA-6" is now used by Cola 6pk. Change it on that product, or give this one a new SKU.`,
      blocked: false,
    },
  ],
  holderIds: ["h1"],
  canResolve: true,
  ...over,
});

function setup(refusal: ReactivationRefusal | null) {
  const onClose = jest.fn();
  const onResolve = jest.fn();
  const onRetry = jest.fn();
  render(
    <ReactivateConflictDialog
      refusal={refusal}
      onClose={onClose}
      onResolve={onResolve}
      onRetry={onRetry}
    />,
  );
  return { onClose, onResolve, onRetry };
}

describe("ReactivateConflictDialog", () => {
  it("renders nothing when there is no refusal", () => {
    setup(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the approved line, a link to the holder, and the one-call button", () => {
    const { onResolve } = setup(holders());
    expect(
      screen.getByText(
        `Can't reactivate: the SKU "COLA-6" is now used by Cola 6pk. Change it on that product, or give this one a new SKU.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cola 6pk" })).toHaveAttribute("href", "/products/h1");
    fireEvent.click(screen.getByText('Deactivate "Cola 6pk" and reactivate this'));
    expect(onResolve).toHaveBeenCalledWith(["h1"]);
  });

  it("two holders -> every line, both ids in one resolve", () => {
    const r = holders({
      holders: [
        { productId: "h1", productName: "A", line: "line A", blocked: false },
        { productId: "h2", productName: "B", line: "line B", blocked: false },
      ],
      holderIds: ["h1", "h2"],
    });
    const { onResolve } = setup(r);
    expect(screen.getByText("line A")).toBeInTheDocument();
    expect(screen.getByText("line B")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reactivate-resolve"));
    expect(onResolve).toHaveBeenCalledWith(["h1", "h2"]);
  });

  it("a blocked holder -> NO one-call button, only the change-it-there path", () => {
    setup(
      holders({
        holders: [{ productId: "h1", productName: "Cola family", line: "x", blocked: true }],
        canResolve: false,
      }),
    );
    expect(screen.queryByTestId("reactivate-resolve")).toBeNull();
    expect(screen.getByText(/has active variants/)).toBeInTheDocument();
  });

  it("cancel/close does not resolve", () => {
    const { onClose, onResolve } = setup(holders());
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("a hostile product name is text, not markup", () => {
    const name = `<img src=x onerror=alert(1)>`;
    setup(
      holders({ holders: [{ productId: "h1", productName: name, line: "l", blocked: false }] }),
    );
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name })).toBeInTheDocument();
  });

  it("retry kind -> a retry prompt, no holder list", () => {
    const { onRetry } = setup({ kind: "RETRY" });
    fireEvent.click(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.queryByTestId("reactivate-resolve")).toBeNull();
  });

  it("a holder with no productId: its line shows, but no link and no one-call button", () => {
    setup({
      kind: "HOLDERS",
      holders: [{ productId: "", productName: "", line: "name line", blocked: false }],
      holderIds: [],
      canResolve: false,
    });
    expect(screen.getByText("name line")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByTestId("reactivate-resolve")).toBeNull();
  });
});
