import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { InvoicePreviewToggle } from "./InvoicePreviewToggle";
import type { InvoicePdfVariant } from "@/lib/api/invoices";

/**
 * B1372 (SA-1177 K4.1, owner box Q3 "Invoice page switch"): the owner picked Final on this switch, a refetch put it back on
 * Draft, and "the word final goes away". The switch is a preview of the printed / downloaded / emailed copy, so it says so,
 * starts on the server's stage, and when the preview differs it states the invoice's own stage. Placeholders only.
 */
function Harness({ stage }: { stage: InvoicePdfVariant }) {
  const [pick, setPick] = React.useState<InvoicePdfVariant | null>(null);
  return <InvoicePreviewToggle stage={stage} preview={pick ?? stage} onPreview={setPick} />;
}

describe("InvoicePreviewToggle (B1372 K4.1)", () => {
  it('is labelled "Preview as:" with Draft and Final, and starts on the server stage', () => {
    render(<Harness stage="draft" />);
    const group = screen.getByRole("group", { name: "Preview as:" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Final" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("invoice-preview-note")).toBeNull();
  });

  it("previewing Final on a draft says it is a preview and the invoice is still a draft", () => {
    render(<Harness stage="draft" />);
    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    expect(screen.getByRole("button", { name: "Final" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("invoice-preview-note")).toHaveTextContent(
      "Preview only. This invoice is a draft.",
    );
  });

  it("previewing Draft on a final invoice says the invoice is final; picking the stage again clears the note", () => {
    render(<Harness stage="final" />);
    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    expect(screen.getByTestId("invoice-preview-note")).toHaveTextContent(
      "Preview only. This invoice is final.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Final" }));
    expect(screen.queryByTestId("invoice-preview-note")).toBeNull();
  });
});
