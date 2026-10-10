/**
 * B743 PR B (REG-B743-web): the PACK_SIZE_UNKNOWN dialog makes the loose-pieces choice explicit.
 */
import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { LOOSE_PIECES_CONSEQUENCE, PackSizeUnknownModal } from "./PackSizeUnknownModal";
import type { PackSizeUnknownError } from "@/lib/api/vendor-bills";

const payload: PackSizeUnknownError = {
  code: "PACK_SIZE_UNKNOWN",
  message: '"Sample Cola" doesn\'t state units per case.',
  packSizeUnknownItems: [
    {
      id: "vbi-1",
      lineIndex: 0,
      description: "Sample Cola",
      productId: "p-1",
      productName: "Sample Cola 12pk",
      qty: 2,
      unitCost: 30,
      productPack: 12,
    },
  ],
};

describe("B743 — PackSizeUnknownModal (REG-B743-web)", () => {
  it("lists each flagged line with its known case size", () => {
    render(
      <PackSizeUnknownModal
        payload={payload}
        onClose={jest.fn()}
        onFixCaseSizes={jest.fn()}
        onReceiveLoose={jest.fn()}
        isPending={false}
      />,
    );
    const list = screen.getByRole("list", { name: "Lines missing units per case" });
    expect(list).toHaveTextContent("Sample Cola");
    expect(list).toHaveTextContent("Sample Cola 12pk is usually a case of 12.");
  });

  it("spells out the loose-pieces consequence (a silent choice IS the B743 bug)", () => {
    render(
      <PackSizeUnknownModal
        payload={payload}
        onClose={jest.fn()}
        onFixCaseSizes={jest.fn()}
        onReceiveLoose={jest.fn()}
        isPending={false}
      />,
    );
    expect(LOOSE_PIECES_CONSEQUENCE).toBe("Stock counts each as 1 piece; cost is per piece.");
    expect(screen.getByTestId("loose-pieces-consequence")).toHaveTextContent(
      LOOSE_PIECES_CONSEQUENCE,
    );
  });

  it("each button calls its own handler", () => {
    const onFix = jest.fn();
    const onLoose = jest.fn();
    render(
      <PackSizeUnknownModal
        payload={payload}
        onClose={jest.fn()}
        onFixCaseSizes={onFix}
        onReceiveLoose={onLoose}
        isPending={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fix case sizes" }));
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onLoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Receive as loose pieces" }));
    expect(onLoose).toHaveBeenCalledTimes(1);
  });

  it("a bill that can no longer be edited offers Cancel instead of Fix case sizes", () => {
    const onClose = jest.fn();
    render(
      <PackSizeUnknownModal
        payload={payload}
        onClose={onClose}
        onFixCaseSizes={null}
        onReceiveLoose={jest.fn()}
        isPending={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Fix case sizes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing without a payload", () => {
    render(
      <PackSizeUnknownModal
        payload={null}
        onClose={jest.fn()}
        onFixCaseSizes={jest.fn()}
        onReceiveLoose={jest.fn()}
        isPending={false}
      />,
    );
    expect(screen.queryByText("Units per case missing")).toBeNull();
  });
});
