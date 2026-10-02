import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScanCreateModeSelector } from "./ScanCreateModeSelector";

describe("ScanCreateModeSelector", () => {
  it("bill intent shows the three modes and reports the choice", () => {
    const onChange = jest.fn();
    render(<ScanCreateModeSelector intent="bill" createMode="bill" onChange={onChange} />);
    expect(screen.getByText("What would you like to create?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expense/ }));
    expect(onChange).toHaveBeenCalledWith("expense");
    expect(screen.getByRole("button", { name: /Both/ })).toBeInTheDocument();
  });

  it("purchase-order intent renders nothing: a PO scan always records a bill + its PO", () => {
    const { container } = render(
      <ScanCreateModeSelector intent="purchase-order" createMode="bill" onChange={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
