import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  API_ERROR_CODES,
  DRIVER_RESTRICTION_BLOCK_MESSAGE,
  type RestrictionWarningError,
} from "@routeflow/types";
import { RestrictionWarningDialog } from "./RestrictionWarningDialog";

const warning: RestrictionWarningError = {
  code: API_ERROR_CODES.RESTRICTION_WARNING,
  message: "Some items are restricted.",
  warningHash: "rw1:abc",
  lines: [
    {
      lineKey: "n:0",
      productId: "p1",
      displayName: "Acme Gummies",
      outcome: "BLOCK",
      rules: [
        {
          id: "r1",
          states: ["CA"],
          legal: true,
          reasonText: "This product is banned in CA by law.",
        },
      ],
    },
    {
      lineKey: "l:item-9",
      productId: "p2",
      displayName: "Acme Vape",
      outcome: "BLOCK",
      rules: [{ id: "r2", states: ["CA"], legal: false, reasonText: "Limited in CA." }],
    },
    {
      lineKey: "n:3",
      productId: "p3",
      displayName: "Acme Tonic",
      outcome: "INDETERMINATE",
      rules: [],
    },
  ],
};

function setup(over: Partial<React.ComponentProps<typeof RestrictionWarningDialog>> = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <RestrictionWarningDialog
      view={{ kind: "warning", warning }}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onConfirm, onCancel, ...utils };
}

describe("RestrictionWarningDialog (warning)", () => {
  it("lists every breached line with its name and rules, and the legal copy with the state filled in", () => {
    setup();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Acme Gummies")).toBeInTheDocument();
    expect(screen.getByText("Acme Vape")).toBeInTheDocument();
    expect(screen.getByText("Acme Tonic")).toBeInTheDocument();
    expect(screen.getByText("This product is banned in CA by law.")).toBeInTheDocument();
    expect(screen.getByText("Limited in CA.")).toBeInTheDocument();
  });

  it("marks only a legal rule with the Legal ban badge", () => {
    setup();
    expect(screen.getAllByText("Legal ban")).toHaveLength(1);
  });

  it("explains an indeterminate line without a raw code", () => {
    setup();
    expect(screen.getByText(/couldn't be checked/i)).toBeInTheDocument();
    expect(screen.queryByText(/INDETERMINATE/)).toBeNull();
  });

  it("has ONE reason field", () => {
    setup();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("keeps Sell anyway disabled under 3 and over 200 characters, with live validation", async () => {
    const user = userEvent.setup();
    setup();
    const sell = screen.getByRole("button", { name: "Sell anyway" });
    const field = screen.getByLabelText(/reason/i);
    expect(sell).toBeDisabled();
    await user.type(field, "ab");
    expect(sell).toBeDisabled();
    expect(screen.getByText(/at least 3 characters/i)).toBeInTheDocument();
    await user.type(field, "c");
    expect(sell).toBeEnabled();
    fireEvent.change(field, { target: { value: "x".repeat(201) } });
    expect(sell).toBeDisabled();
    expect(screen.getByText(/200 characters or fewer/i)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "   ab   " } }); // trimmed length 2
    expect(sell).toBeDisabled();
  });

  it("Sell anyway resolves the per-line reasons (trimmed) and the server's warningHash", async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.type(screen.getByLabelText(/reason/i), "  Owner approved it  ");
    await user.click(screen.getByRole("button", { name: "Sell anyway" }));
    expect(onConfirm).toHaveBeenCalledWith(
      {
        restrictionOverrides: [
          { lineKey: "n:0", reason: "Owner approved it" },
          { lineKey: "l:item-9", reason: "Owner approved it" },
          { lineKey: "n:3", reason: "Owner approved it" },
        ],
        warningHash: "rw1:abc",
      },
      "Owner approved it",
    );
  });

  it("Go back closes without confirming", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = setup();
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("prefills the typed reason when it is re-shown with a fresh list", () => {
    setup({ initialReason: "Owner approved it" });
    expect(screen.getByLabelText(/reason/i)).toHaveValue("Owner approved it");
    expect(screen.getByRole("button", { name: "Sell anyway" })).toBeEnabled();
  });

  it("says the list changed in a polite live region when it is re-shown (listChanged), and not otherwise", () => {
    const { unmount } = setup();
    expect(screen.queryByRole("status")).toBeNull();
    unmount();
    setup({ listChanged: true });
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("The list changed; review it again");
    expect(notice).toHaveAttribute("aria-live", "polite");
  });

  it("Go back and Sell anyway are 44px tall below md (max-md:min-h-11), the owner's touch-target rule", () => {
    setup();
    for (const name of ["Go back", "Sell anyway"]) {
      const cls = screen.getByRole("button", { name }).className;
      expect(cls).toContain("max-md:min-h-11");
    }
  });

  it("opens with focus in the Reason field, not on the close button", () => {
    setup();
    expect(document.activeElement).toBe(screen.getByLabelText(/reason/i));
  });

  it("still closes on Escape", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    setup({ view: null });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("RestrictionWarningDialog (driver hard block)", () => {
  const view = {
    kind: "blocked" as const,
    message: DRIVER_RESTRICTION_BLOCK_MESSAGE,
    lines: [
      {
        productId: "p1",
        productName: "Acme Gummies",
        ruleId: "r1",
        reason: "STATE_BAN" as const,
        state: "CA",
        message: "m",
      },
    ],
  };
  it("says to ask the office, lists the items, and offers no override", () => {
    const { onCancel } = setup({ view });
    expect(screen.getAllByText("Ask the office to approve this sale").length).toBeGreaterThan(0);
    expect(screen.getByText("Acme Gummies")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sell anyway" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onCancel).toHaveBeenCalled();
  });
  it("OK is 44px tall below md too", () => {
    setup({ view });
    expect(screen.getByRole("button", { name: "OK" }).className).toContain("max-md:min-h-11");
  });
  it("shows the same legal line and badge staff see when the server sent per-rule lines", () => {
    setup({
      view: {
        ...view,
        ruleLines: [
          {
            lineKey: "n:0",
            productId: "p1",
            displayName: "Acme Gummies",
            outcome: "BLOCK",
            rules: [
              {
                id: "r1",
                states: ["CA"],
                legal: true,
                reasonText: "This product is banned in CA by law.",
              },
            ],
          },
        ],
      },
    });
    expect(screen.getByText("This product is banned in CA by law.")).toBeInTheDocument();
    expect(screen.getByText("Legal ban")).toBeInTheDocument();
    expect(screen.queryByText("Restricted in CA")).toBeNull();
  });
});
