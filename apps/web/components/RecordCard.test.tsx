import * as React from "react";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen } from "@testing-library/react";
import { RecordCard, RecordCardList } from "./RecordCard";

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

function renderCard(extra: Partial<React.ComponentProps<typeof RecordCard>> = {}) {
  return render(
    <RecordCardList>
      <RecordCard
        href="/invoices/inv-1"
        title="INV-1001"
        amount="$120.00"
        subtitle="Acme Foods"
        badges={<span>Sent</span>}
        meta={<span>Jan 5, 2026</span>}
        actions={<button type="button">Print</button>}
        {...extra}
      />
    </RecordCardList>,
  );
}

describe("RecordCard", () => {
  beforeEach(() => push.mockClear());

  it("renders title, amount, subtitle, badges and meta", () => {
    renderCard();
    expect(screen.getByText("INV-1001")).toBeInTheDocument();
    expect(screen.getByText("$120.00")).toBeInTheDocument();
    expect(screen.getByText("Acme Foods")).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Jan 5, 2026")).toBeInTheDocument();
  });

  it("wraps the cards in a list that is hidden from md up", () => {
    const { container } = renderCard();
    const list = container.querySelector("ul") as HTMLElement;
    expect(list.className).toContain("space-y-3");
    expect(list.className).toContain("md:hidden");
  });

  it("the title is a real link to the record, stretched over the card (A1-2)", () => {
    const { container } = renderCard();
    const link = screen.getByRole("link", { name: "INV-1001" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/invoices/inv-1");
    expect(link.className).toContain("after:absolute");
    expect(link.className).toContain("after:inset-0");
    const card = container.querySelector("[data-record-card]") as HTMLElement;
    expect(card.className).toContain("relative");
    expect(card).not.toHaveAttribute("role");
    expect(card).not.toHaveAttribute("tabindex");
    expect(container.querySelectorAll("[role=link]")).toHaveLength(0);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("clicking the card body does no script navigation (the link does it)", async () => {
    const user = userEvent.setup();
    const { container } = renderCard();
    await user.click(container.querySelector("[data-record-card]") as HTMLElement);
    expect(push).not.toHaveBeenCalled();
  });

  it("actions sit on the last row with the meta, above the link, with no footer border", async () => {
    const user = userEvent.setup();
    const { container } = renderCard();
    const button = screen.getByRole("button", { name: "Print" });
    const actions = button.parentElement as HTMLElement;
    expect(actions.className).toContain("relative");
    expect(actions.className).toContain("z-10");
    expect(actions.parentElement).toContainElement(screen.getByText("Jan 5, 2026"));
    expect(container.querySelector("[data-record-card]")!.innerHTML).not.toContain("border-t");
    await user.click(button);
    expect(push).not.toHaveBeenCalled();
  });

  it("has no urgent prop: the card never takes a danger border", () => {
    const { container } = renderCard();
    expect(container.querySelector("[data-record-card]")!.className).not.toContain("border-l-");
  });

  it("shows an amount label and tones the amount danger on request", () => {
    renderCard({ amountLabel: "Balance due", amountTone: "danger" });
    expect(screen.getByText("Balance due")).toBeInTheDocument();
    expect(screen.getByText("$120.00").className).toContain("text-danger");
  });

  it("keeps the default amount tone and no label when none is given", () => {
    renderCard();
    expect(screen.getByText("$120.00").className).not.toContain("text-danger");
    expect(screen.queryByText("Balance due")).toBeNull();
  });

  it("gives a string subtitle a title so a truncated name can be read", () => {
    renderCard();
    expect(screen.getByText("Acme Foods")).toHaveAttribute("title", "Acme Foods");
  });

  it("sets no title for a node subtitle", () => {
    renderCard({ subtitle: <b>Acme</b> });
    expect(screen.getByText("Acme").closest("p")).not.toHaveAttribute("title");
  });

  describe("title kind and dimming", () => {
    it("shows a number title in mono by default", () => {
      renderCard();
      const link = screen.getByRole("link", { name: "INV-1001" });
      expect(link.className).toContain("font-mono");
    });

    it("shows a name title in the normal sans text at the same size", () => {
      renderCard({ title: "Acme Foods", titleKind: "name" });
      const link = screen.getByRole("link", { name: "Acme Foods" });
      expect(link.className).not.toContain("font-mono");
      expect(link.className).toContain("text-xs");
      expect(link.className).toContain("font-semibold");
    });

    it("dims the whole card on request, like a dimmed table row", () => {
      const { container } = renderCard({ dimmed: true });
      expect(container.querySelector("[data-record-card]")!.className).toContain("opacity-50");
    });

    it("is not dimmed by default", () => {
      const { container } = renderCard();
      expect(container.querySelector("[data-record-card]")!.className).not.toContain("opacity-50");
    });
  });

  describe("selection (optional, for pages with bulk actions)", () => {
    it("renders no checkbox unless onSelectedChange is given", () => {
      renderCard();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });

    it("renders a 44x44 checkbox named with the title, above the stretched link", async () => {
      const user = userEvent.setup();
      const onSelectedChange = jest.fn();
      renderCard({ selected: false, onSelectedChange });
      const box = screen.getByRole("checkbox", { name: "Select INV-1001" });
      expect(box).not.toBeChecked();
      const target = box.closest("label") as HTMLElement;
      expect(target.className).toContain("h-11");
      expect(target.className).toContain("w-11");
      expect(target.className).toContain("relative");
      expect(target.className).toContain("z-10");
      await user.click(box);
      expect(onSelectedChange).toHaveBeenCalledWith(true);
      expect(push).not.toHaveBeenCalled();
    });

    it("shows the selected state and reports the unchecking", async () => {
      const user = userEvent.setup();
      const onSelectedChange = jest.fn();
      const { container } = renderCard({ selected: true, onSelectedChange });
      const box = screen.getByRole("checkbox", { name: "Select INV-1001" });
      expect(box).toBeChecked();
      expect(container.querySelector("[data-record-card]")!.className).toContain("bg-brand-50");
      await user.click(box);
      expect(onSelectedChange).toHaveBeenCalledWith(false);
    });

    it("can show the checkbox disabled, with the reason as its title", async () => {
      const user = userEvent.setup();
      const onSelectedChange = jest.fn();
      renderCard({
        selected: false,
        onSelectedChange,
        selectDisabled: true,
        selectDisabledReason: "Protected record",
      });
      const box = screen.getByRole("checkbox", { name: "Select INV-1001" });
      expect(box).toBeDisabled();
      expect(box).toHaveAttribute("title", "Protected record");
      await user.click(box);
      expect(onSelectedChange).not.toHaveBeenCalled();
    });

    it("with tapToSelect, tapping the card toggles the selection instead of opening it", async () => {
      const user = userEvent.setup();
      const onSelectedChange = jest.fn();
      renderCard({ selected: false, onSelectedChange, tapToSelect: true });
      const link = screen.getByRole("link", { name: "INV-1001" });
      expect(fireEvent.click(link)).toBe(false); // navigation prevented
      expect(onSelectedChange).toHaveBeenCalledWith(true);
      await user.click(screen.getByRole("checkbox", { name: "Select INV-1001" }));
      expect(onSelectedChange).toHaveBeenCalledTimes(2);
    });

    it("with tapToSelect, a disabled card still opens", () => {
      const onSelectedChange = jest.fn();
      renderCard({ onSelectedChange, tapToSelect: true, selectDisabled: true });
      expect(fireEvent.click(screen.getByRole("link", { name: "INV-1001" }))).toBe(true);
      expect(onSelectedChange).not.toHaveBeenCalled();
    });

    it("without tapToSelect, tapping the card opens it and does not select", () => {
      const onSelectedChange = jest.fn();
      renderCard({ selected: false, onSelectedChange });
      fireEvent.click(screen.getByRole("link", { name: "INV-1001" }));
      expect(onSelectedChange).not.toHaveBeenCalled();
    });

    it("keeps the title the only link", () => {
      renderCard({ selected: false, onSelectedChange: jest.fn() });
      expect(screen.getAllByRole("link")).toHaveLength(1);
    });
  });
});
