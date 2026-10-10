import * as React from "react";
import { renderWithProviders as render, screen } from "@/test-utils/render";
import { Input, PasswordInput, Select, Textarea } from "@routeflow/ui/web";
import { AddressAutocomplete } from "./AddressAutocomplete";

// B891 (root): the shared fields derived their default id from the LABEL, so two fields with the
// same label (any repeated row) shared one id and every label targeted the FIRST field. The default
// is now React.useId(); an explicit id still wins.
describe("B891: labelled fields get a unique default id", () => {
  it.each([
    ["Input", () => <Input label="Qty" />],
    ["Textarea", () => <Textarea label="Qty" />],
    ["PasswordInput", () => <PasswordInput label="Qty" />],
    ["Select", () => <Select label="Qty" options={[{ value: "1", label: "1" }]} />],
  ])("%s: two same-labelled fields ⇒ each label targets its own field", (_name, Field) => {
    render(
      <>
        <Field />
        <Field />
      </>,
    );
    const fields = screen.getAllByLabelText("Qty");
    expect(fields).toHaveLength(2);
    expect(fields[0]).not.toBe(fields[1]);
    expect(fields[0].id).toBeTruthy();
    expect(fields[0].id).not.toBe(fields[1].id);
  });

  it("an explicit id still wins", () => {
    render(<Input label="Password" id="password" />);
    expect(screen.getByLabelText("Password")).toHaveAttribute("id", "password");
  });

  it("AddressAutocomplete: two instances ⇒ distinct ids, each label → its own input", () => {
    render(
      <>
        <AddressAutocomplete
          label="Street"
          value=""
          onChange={() => {}}
          onAddressSelect={() => {}}
        />
        <AddressAutocomplete
          label="Street"
          value=""
          onChange={() => {}}
          onAddressSelect={() => {}}
        />
      </>,
    );
    const fields = screen.getAllByLabelText("Street");
    expect(fields).toHaveLength(2);
    expect(fields[0].id).not.toBe(fields[1].id);
  });
});
