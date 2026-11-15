import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
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

  it("opens the record on click and on Enter", async () => {
    const user = userEvent.setup();
    renderCard();
    const card = screen.getByRole("link");
    await user.click(card);
    expect(push).toHaveBeenCalledWith("/invoices/inv-1");
    push.mockClear();
    card.focus();
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/invoices/inv-1");
  });

  it("an action button press does not navigate, and the button is outside the link", async () => {
    const user = userEvent.setup();
    renderCard();
    const button = screen.getByRole("button", { name: "Print" });
    expect(screen.getByRole("link")).not.toContainElement(button);
    await user.click(button);
    expect(push).not.toHaveBeenCalled();
  });

  it("marks an urgent card with the danger border", () => {
    renderCard({ urgent: true });
    expect(screen.getByRole("link").closest("[data-record-card]")!.className).toContain(
      "border-l-danger",
    );
  });
});
