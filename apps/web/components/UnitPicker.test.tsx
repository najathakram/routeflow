import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { heldSnapshotOption } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { UnitPicker } from "./UnitPicker";

const product = { unit: "Box", unitsPerBox: 24, pricePerUnit: "42.00" };

const CASE: ProductUnitLevel = {
  id: "u1",
  label: "Case",
  factorToBase: 288,
  price: "480.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
};

describe("UnitPicker", () => {
  it("renders nothing while the ladder is loading or when the product has no levels", () => {
    const { container, rerender } = render(
      <UnitPicker product={product} units={undefined} value="" onChange={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<UnitPicker product={product} units={[]} value="" onChange={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the pack (empty value), each level and the Piece, with the tier's price", () => {
    render(<UnitPicker product={product} units={[CASE]} value="" onChange={jest.fn()} />);
    const select = screen.getByLabelText("Sell by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.text])).toEqual([
      ["", "Box · 24 pcs · $42.00"],
      ["Case", "Case · 288 pcs · $480.00"],
      ["Piece", "Piece · $1.75"],
    ]);
    expect(select.value).toBe("");
  });

  it("reports the chosen unit label, and the pack as an empty string", () => {
    const onChange = jest.fn();
    render(<UnitPicker product={product} units={[CASE]} value="" onChange={onChange} />);
    const select = screen.getByLabelText("Sell by");
    fireEvent.change(select, { target: { value: "Case" } });
    expect(onChange).toHaveBeenLastCalledWith("Case");
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("shows the selected unit", () => {
    render(<UnitPicker product={product} units={[CASE]} value="Case" onChange={jest.fn()} />);
    expect((screen.getByLabelText("Sell by") as HTMLSelectElement).value).toBe("Case");
  });

  it("tells the parent to reset a held label the ladder does not offer — never masks it as the pack", () => {
    const onChange = jest.fn();
    render(<UnitPicker product={product} units={[CASE]} value="Pallet" onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("resets a held label even when the picker is hidden (product swapped to one with no levels)", () => {
    const onChange = jest.fn();
    render(<UnitPicker product={product} units={[]} value="Case" onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("SA-1044 A-3: an empty ladder keeps a held snapshot option selected — no reset", () => {
    const onChange = jest.fn();
    const heldOption = heldSnapshotOption({
      unitLabel: "Case",
      unitsPerBox: 100,
      unitPrice: 50,
      listPrice: 55,
    });
    render(
      <UnitPicker
        product={product}
        units={[]}
        heldOption={heldOption}
        value="Case"
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: /Case of 100 \(as ordered\)/ })).toBeInTheDocument();
    expect((screen.getByLabelText("Sell by") as HTMLSelectElement).value).toBe("Case");
  });

  it("does not touch the parent while the ladder is still loading or the held label is valid", () => {
    const onChange = jest.fn();
    const { rerender } = render(
      <UnitPicker product={product} units={undefined} value="Case" onChange={onChange} />,
    );
    rerender(<UnitPicker product={product} units={[CASE]} value="Case" onChange={onChange} />);
    rerender(<UnitPicker product={product} units={[CASE]} value="" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a Piece-only ladder still renders the picker", () => {
    const only = { ...CASE, id: "p", label: "Piece", factorToBase: 1, price: "2.00" };
    render(<UnitPicker product={product} units={[only]} value="" onChange={jest.fn()} />);
    const select = screen.getByLabelText("Sell by") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "Piece"]);
  });

  it("a bad tier never throws out of render and never resets the held unit", () => {
    const onChange = jest.fn();
    const { container } = render(
      <UnitPicker product={product} units={[CASE]} tier={0} value="Case" onChange={onChange} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the parent's pack price and takes a distinct accessible name", () => {
    render(
      <UnitPicker
        product={product}
        units={[CASE]}
        packPrice={38}
        ariaLabel="Sell Widget by"
        value=""
        onChange={jest.fn()}
      />,
    );
    const select = screen.getByLabelText("Sell Widget by") as HTMLSelectElement;
    expect(select.options[0].text).toBe("Box · 24 pcs · $38.00");
  });

  it("can be disabled", () => {
    render(<UnitPicker product={product} units={[CASE]} value="" onChange={jest.fn()} disabled />);
    expect(screen.getByLabelText("Sell by")).toBeDisabled();
  });
});
