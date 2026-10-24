import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import type { SellingRestrictionListItemDto } from "@/lib/api/restrictions-admin";
import { REASON_MAX } from "@/lib/restriction-rule-form";
import { LiftRuleDialog } from "./LiftRuleDialog";

const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { post: (...a: unknown[]) => post(...a) },
}));

const rule = { id: "r1", categoryName: "Hemp", productName: null } as SellingRestrictionListItemDto;
const open = (onClose = jest.fn()) => {
  renderWithProviders(<LiftRuleDialog rule={rule} onClose={onClose} />);
  return onClose;
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Lift rule" }));
beforeEach(() => jest.clearAllMocks());

describe("LiftRuleDialog", () => {
  it("names the rule's target and refuses a blank reason without a request", async () => {
    open();
    expect(screen.getByText(/Hemp will stop being restricted/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "   " } });
    submit();
    expect(await screen.findByText("Add a reason")).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("a rule that covers many products says so instead of naming one", () => {
    const many = {
      ...rule,
      categoryName: null,
      targetSummary: { products: 12, categories: 1, preview: [] },
    } as SellingRestrictionListItemDto;
    renderWithProviders(<LiftRuleDialog rule={many} onClose={jest.fn()} />);
    expect(
      screen.getByText(/The 13 products and labels in this rule will stop being restricted/),
    ).toBeInTheDocument();
  });

  it("posts the trimmed reason to the lift endpoint, then closes", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    const onClose = open();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: " Law repealed " } });
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/selling-restrictions/r1/lift", { reason: "Law repealed" });
  });

  it("a refused lift keeps the dialog open with the reason", async () => {
    post.mockRejectedValueOnce(new Error("already lifted"));
    const onClose = open();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Repealed" } });
    submit();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Reason")).toHaveValue("Repealed");
  });

  it("caps the textarea past REASON_MAX and reports the real limit, not a hardcoded one", async () => {
    open();
    expect(screen.getByLabelText("Reason")).toHaveAttribute("maxLength", String(REASON_MAX + 50));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "x".repeat(REASON_MAX + 1) },
    });
    submit();
    expect(
      await screen.findByText(`Keep the reason under ${REASON_MAX} characters`),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it("Escape returns focus to the button that opened it", async () => {
    function Harness() {
      const [r, setR] = React.useState<typeof rule | null>(null);
      return (
        <>
          <button onClick={() => setR(rule)}>Open</button>
          <LiftRuleDialog rule={r} onClose={() => setR(null)} />
        </>
      );
    }
    renderWithProviders(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Lift this rule?" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
