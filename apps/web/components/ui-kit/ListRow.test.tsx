import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListRow } from "@routeflow/ui/web";

describe("ListRow", () => {
  it("static row is not a button; interactive row is a button that Enter/Space activate", async () => {
    const onActivate = jest.fn();
    const { rerender } = render(
      <ul>
        <ListRow title="Soda" meta="Case of 24" />
      </ul>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <ul>
        <ListRow title="Soda" meta="Case of 24" onActivate={onActivate} />
      </ul>,
    );
    const b = screen.getByRole("button", { name: /soda/i });
    b.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await userEvent.click(b);
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it("renders leading, title, meta and trailing", () => {
    render(
      <ul>
        <ListRow leading={<i>L</i>} title="T" meta="M" trailing={<b>R</b>} />
      </ul>,
    );
    ["L", "T", "M", "R"].forEach((t) => expect(screen.getByText(t)).toBeInTheDocument());
  });

  it("has a 44px minimum target", () => {
    render(
      <ul>
        <ListRow title="T" onActivate={() => {}} />
      </ul>,
    );
    expect(screen.getByRole("button").className).toMatch(/min-h-\[44px\]/);
  });

  it("the inset divider is suppressed on the last row only (last:after:hidden) and inset by default", () => {
    render(
      <ul>
        <ListRow title="A" />
        <ListRow title="B" inset={false} />
      </ul>,
    );
    const [a, b] = screen.getAllByRole("listitem");
    expect(a!.className).toMatch(/after:left-3/);
    expect(a!.className).toMatch(/last:after:hidden/);
    expect(b!.className).toMatch(/after:left-0/);
  });

  it("can render as a div and reports selected", () => {
    render(<ListRow as="div" title="X" selected onActivate={() => {}} />);
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });
});
