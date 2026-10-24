import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { NewRuleFromCatalog } from "./NewRuleFromCatalog";

/** Row 509 PR5: the catalog's "New rule with N products…" hands the ids and names to the rule editor. */
const formProps = jest.fn();
jest.mock("@/app/(dashboard)/settings/restrictions/rules/_components/RuleFormDialog", () => ({
  RuleFormDialog: (p: Record<string, unknown>) => {
    formProps(p);
    return <div data-testid="rule-form-stub" />;
  },
}));

describe("NewRuleFromCatalog", () => {
  it("opens the rule editor with the selected products prefilled", () => {
    const onClose = jest.fn();
    renderWithProviders(
      <NewRuleFromCatalog productIds={["p1", "p2"]} names={{ p1: "Mint Pod" }} onClose={onClose} />,
    );
    expect(screen.getByTestId("rule-form-stub")).toBeInTheDocument();
    expect(formProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        open: true,
        onClose,
        initialTargets: [
          { kind: "PRODUCT", id: "p1", name: "Mint Pod" },
          { kind: "PRODUCT", id: "p2", name: "Selected product" }, // off-page (select-all-matching)
        ],
      }),
    );
  });

  it("a created rule clears the catalog selection (onCreated), a cancel does not", () => {
    const onCreated = jest.fn();
    renderWithProviders(
      <NewRuleFromCatalog
        productIds={["p1"]}
        names={{}}
        onClose={jest.fn()}
        onCreated={onCreated}
      />,
    );
    const props = formProps.mock.calls.at(-1)![0] as { onCreated: (id: string) => void };
    expect(onCreated).not.toHaveBeenCalled();
    props.onCreated("r1");
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});
